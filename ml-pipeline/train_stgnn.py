import os
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GCNConv
from torch_geometric.data import Data
import pandas as pd
import numpy as np
from tqdm import tqdm
import matplotlib.pyplot as plt

# --------------------------
# 1. Real Graph Construction
# --------------------------
def load_real_colombo_graph():
    """
    Loads map-matched OSM data from PostGIS/OSRM, compresses the billions of
    potential OSM Node IDs into a continuous 0-N PyTorch index, and constructs
    the edge index and 24-hour temporal node features.
    """
    print("Loading real map-matched traffic data...")
    csv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "real_traffic_edges.csv"))
    
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Missing {csv_path}. Please run map_matcher.py first.")
        
    df = pd.read_csv(csv_path)
    
    # Extract unique OSM Node IDs
    unique_nodes = pd.unique(df[['source_node', 'target_node']].values.ravel('K'))
    num_nodes = len(unique_nodes)
    print(f"Extracted {num_nodes} unique physical intersections (nodes).")
    
    # Create mapping from OSM ID to PyTorch ID (0 to N-1)
    node_mapping = {osm_id: pt_id for pt_id, osm_id in enumerate(unique_nodes)}
    
    # Map edge list
    df['pt_source'] = df['source_node'].map(node_mapping)
    df['pt_target'] = df['target_node'].map(node_mapping)
    
    # Create edge_index [2, num_edges]
    # We only need unique edges regardless of time
    unique_edges = df[['pt_source', 'pt_target']].drop_duplicates()
    edge_index = torch.tensor(unique_edges.values.T, dtype=torch.long)
    print(f"Extracted {edge_index.size(1)} unique road segments (edges).")
    
    # Create temporal node features X [num_nodes, 24, 1] (24 hours)
    # We assign the speed of a road to its target intersection.
    # Default speed for missing hours is 30 km/h
    X_numpy = np.full((num_nodes, 24, 1), 30.0, dtype=np.float32)
    
    for _, row in df.iterrows():
        node_id = int(row['pt_target'])
        hour = int(row['hour']) % 24
        speed = float(row['avg_speed'])
        
        # In case a node has multiple incoming roads at the same hour, we average them
        if X_numpy[node_id, hour, 0] == 30.0:
            X_numpy[node_id, hour, 0] = speed
        else:
            X_numpy[node_id, hour, 0] = (X_numpy[node_id, hour, 0] + speed) / 2
            
    X_tensor = torch.tensor(X_numpy)
    
    data = Data(x=X_tensor, edge_index=edge_index)
    return data, node_mapping

# --------------------------
# 2. Model Architecture
# --------------------------
class STGNN(nn.Module):
    def __init__(self, seq_len=12, hidden_dim=64, future_steps=1):
        super(STGNN, self).__init__()
        self.seq_len = seq_len
        self.hidden_dim = hidden_dim
        
        self.gru1 = nn.GRU(input_size=1, hidden_size=hidden_dim, batch_first=True)
        # Spatial Graph Convolution (Residual)
        self.gcn1 = GCNConv(hidden_dim, hidden_dim, normalize=False)
        self.gcn2 = GCNConv(hidden_dim, hidden_dim, normalize=False)
        self.gru2 = nn.GRU(input_size=hidden_dim, hidden_size=hidden_dim, batch_first=True)
        
        self.fc1 = nn.Linear(hidden_dim, 32)
        self.fc2 = nn.Linear(32, future_steps)
        self.dropout = nn.Dropout(0.2)
        
    def forward(self, x, edge_index):
        # x shape: [num_nodes, seq_len, 1]
        batch_size = x.size(0)
        
        # Temporal Gating 1
        out, h_n = self.gru1(x) # out: [num_nodes, seq_len, hidden_dim]
        
        # We take the last time step for spatial message passing
        t_last = out[:, -1, :] # [num_nodes, hidden_dim]
        
        # Spatial Graph Convolution (with Residual Connection)
        g_out = self.gcn1(t_last, edge_index)
        g_out = F.relu(g_out)
        g_out = self.dropout(g_out)
        
        g_out2 = self.gcn2(g_out, edge_index)
        g_out2 = F.relu(g_out2)
        
        # Residual connection
        spatial_features = t_last + g_out2 # [num_nodes, hidden_dim]
        
        # Decode future predictions
        pred = self.fc1(spatial_features)
        pred = F.relu(pred)
        pred = self.dropout(pred)
        pred = self.fc2(pred) # [num_nodes, future_steps]
        
        return pred

# --------------------------
# 3. Training Loop
# --------------------------
def main():
    print("Starting Real-World ST-GNN Training on Colombo OSM Graph...")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using hardware accelerator: {device}")
    
    # 1. Load Real Data
    data, mapping = load_real_colombo_graph()
    data = data.to(device)
    
    # We will use 12 hours of sequence to predict the next 1 hour
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    
    # To maximize our data, we'll slice the 24 hours into 12 distinct training windows
    # Window 0: hours 0-11 -> predict hour 12
    # Window 1: hours 1-12 -> predict hour 13
    # ...
    
    model = STGNN(seq_len=SEQ_LEN, hidden_dim=64, future_steps=FUTURE_STEPS).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.005)
    criterion = nn.MSELoss()
    
    # We'll split the nodes into 80% train / 20% test
    num_nodes = data.x.size(0)
    indices = torch.randperm(num_nodes)
    train_idx = indices[:int(0.8 * num_nodes)]
    test_idx = indices[int(0.8 * num_nodes):]
    
    EPOCHS = 150
    train_losses = []
    test_losses = []
    
    print("\nCommencing ST-GNN Training on REAL GPS data...")
    for epoch in tqdm(range(EPOCHS)):
        model.train()
        optimizer.zero_grad()
        
        total_train_loss = 0
        total_test_loss = 0
        
        # Train across the time windows
        windows_count = 24 - SEQ_LEN - FUTURE_STEPS
        
        for w in range(windows_count):
            x_window = data.x[:, w:w+SEQ_LEN, :]
            y_window = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0] # target speed
            
            predictions = model(x_window, data.edge_index)
            
            # Loss only on training nodes
            loss = criterion(predictions[train_idx], y_window[train_idx])
            loss.backward()
            optimizer.step()
            
            total_train_loss += loss.item()
            
            # Evaluation on unseen test nodes
            model.eval()
            with torch.no_grad():
                test_pred = model(x_window, data.edge_index)
                t_loss = criterion(test_pred[test_idx], y_window[test_idx])
                total_test_loss += t_loss.item()
            model.train()
            
        train_losses.append(total_train_loss / windows_count)
        test_losses.append(total_test_loss / windows_count)
        
    final_rmse = np.sqrt(test_losses[-1])
    print(f"\nTraining Complete!")
    print(f"📊 Final Test RMSE Error: ±{final_rmse:.2f} km/h (on 20% unseen roads)")
    
    # Save learning curve
    plt.figure(figsize=(10, 5))
    plt.plot(train_losses, label="Train MSE Loss")
    plt.plot(test_losses, label="Test MSE Loss")
    plt.title("ST-GNN Real Colombo Data Learning Curve")
    plt.xlabel("Epochs")
    plt.ylabel("Mean Squared Error (Speed km/h)")
    plt.legend()
    plt.savefig("real_learning_curve.png")
    
    # Save Weights
    model_path = os.path.join(os.path.dirname(__file__), "colombo_traffic_model_real.pth")
    torch.save(model.state_dict(), model_path)
    print(f"💾 Real traffic weights saved to: {model_path}")

if __name__ == "__main__":
    main()
