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
# 2. Benchmark Model Architectures
# --------------------------

class HistoricalAverage:
    """Non-ML Baseline: Predicts the historical average of the target hour."""
    def __init__(self):
        self.node_hour_means = None
        
    def fit(self, X_train):
        # X_train shape: [num_windows, num_nodes, seq_len+1] 
        # For a true implementation, we would group by hour of day across weeks.
        # Here we just take the global mean per node for simplicity.
        self.node_means = X_train.mean(dim=(0, 2)).squeeze() # [num_nodes]
        
    def predict(self, x_window):
        # x_window shape: [num_nodes, seq_len, 1]
        batch_size = x_window.size(0)
        return self.node_means.unsqueeze(1) # [num_nodes, 1]


class PureGRU(nn.Module):
    """Temporal Only Baseline: No spatial GCN layers."""
    def __init__(self, seq_len=12, hidden_dim=64, future_steps=1):
        super(PureGRU, self).__init__()
        self.gru = nn.GRU(input_size=1, hidden_size=hidden_dim, batch_first=True)
        self.fc = nn.Linear(hidden_dim, future_steps)
        
    def forward(self, x, edge_index):
        # Ignore edge_index completely
        out, _ = self.gru(x)
        return self.fc(out[:, -1, :])


class PureGCN(nn.Module):
    """Spatial Only Baseline: No temporal sequence memory, just looks at the immediate previous hour."""
    def __init__(self, hidden_dim=64, future_steps=1):
        super(PureGCN, self).__init__()
        self.gcn1 = GCNConv(1, hidden_dim)
        self.gcn2 = GCNConv(hidden_dim, hidden_dim)
        self.fc = nn.Linear(hidden_dim, future_steps)
        
    def forward(self, x, edge_index):
        # x: [num_nodes, seq_len, 1]. Only take the very last hour t-1
        x_last = x[:, -1, :] 
        g_out = F.relu(self.gcn1(x_last, edge_index))
        g_out = F.relu(self.gcn2(g_out, edge_index))
        return self.fc(g_out)


class STGNN(nn.Module):
    """Spatio-Temporal Graph Neural Network (Our Proposed Model)"""
    def __init__(self, seq_len=12, hidden_dim=64, future_steps=1):
        super(STGNN, self).__init__()
        self.gru1 = nn.GRU(input_size=1, hidden_size=hidden_dim, batch_first=True)
        self.gcn1 = GCNConv(hidden_dim, hidden_dim, normalize=False)
        self.gcn2 = GCNConv(hidden_dim, hidden_dim, normalize=False)
        self.gru2 = nn.GRU(input_size=hidden_dim, hidden_size=hidden_dim, batch_first=True)
        self.fc1 = nn.Linear(hidden_dim, 32)
        self.fc2 = nn.Linear(32, future_steps)
        self.dropout = nn.Dropout(0.2)
        
    def forward(self, x, edge_index):
        out, _ = self.gru1(x)
        t_last = out[:, -1, :] 
        
        g_out = self.dropout(F.relu(self.gcn1(t_last, edge_index)))
        g_out2 = F.relu(self.gcn2(g_out, edge_index))
        
        spatial_features = t_last + g_out2 
        
        pred = self.dropout(F.relu(self.fc1(spatial_features)))
        return self.fc2(pred)


# --------------------------
# 3. Training & Benchmark Loop
# --------------------------

def compute_metrics(pred, target):
    """Calculate MAE and RMSE in absolute terms (km/h)"""
    pred = pred.detach().cpu().numpy()
    target = target.detach().cpu().numpy()
    mae = np.mean(np.abs(pred - target))
    rmse = np.sqrt(np.mean((pred - target) ** 2))
    return mae, rmse

def train_model(model, optimizer, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device, epochs=50):
    criterion = nn.MSELoss()
    model.to(device)
    
    for epoch in range(epochs):
        model.train()
        for w in train_windows:
            x_w = data.x[:, w:w+SEQ_LEN, :].to(device)
            y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0].to(device)
            
            optimizer.zero_grad()
            pred = model(x_w, data.edge_index.to(device))
            loss = criterion(pred, y_w)
            loss.backward()
            optimizer.step()
            
    # Evaluate on held-out Chronological Test Set
    model.eval()
    all_preds, all_targets = [], []
    with torch.no_grad():
        for w in test_windows:
            x_w = data.x[:, w:w+SEQ_LEN, :].to(device)
            y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0].to(device)
            pred = model(x_w, data.edge_index.to(device))
            all_preds.append(pred)
            all_targets.append(y_w)
            
    return compute_metrics(torch.cat(all_preds), torch.cat(all_targets))


def main():
    print("Starting ML Traffic Forecasting Benchmark on Colombo OSM Graph...")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    
    data, mapping = load_real_colombo_graph()
    
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    total_hours = data.x.size(1) # E.g., 24
    
    windows_count = total_hours - SEQ_LEN - FUTURE_STEPS
    if windows_count < 2:
        print("Not enough temporal data for splitting. Please generate more days of traffic.")
        return
        
    # Chronological Split (No Data Leakage)
    split_idx = int(windows_count * 0.7)
    train_windows = list(range(0, split_idx))
    test_windows = list(range(split_idx, windows_count))
    
    print(f"\nChronological Split:")
    print(f"Training Windows: {train_windows}")
    print(f"Held-Out Test Windows: {test_windows}\n")
    
    # 1. Historical Average
    ha = HistoricalAverage()
    # Build pseudo-train tensor for HA
    train_tensors = [data.x[:, w:w+SEQ_LEN+1, :] for w in train_windows]
    ha.fit(torch.stack(train_tensors))
    
    ha_preds, ha_targets = [], []
    for w in test_windows:
        x_w = data.x[:, w:w+SEQ_LEN, :]
        y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0]
        ha_preds.append(ha.predict(x_w))
        ha_targets.append(y_w)
    ha_mae, ha_rmse = compute_metrics(torch.cat(ha_preds), torch.cat(ha_targets))
    
    # 2. Pure GRU
    gru_model = PureGRU(seq_len=SEQ_LEN)
    gru_opt = torch.optim.Adam(gru_model.parameters(), lr=0.01)
    gru_mae, gru_rmse = train_model(gru_model, gru_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device)
    
    # 3. Pure GCN
    gcn_model = PureGCN()
    gcn_opt = torch.optim.Adam(gcn_model.parameters(), lr=0.01)
    gcn_mae, gcn_rmse = train_model(gcn_model, gcn_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device)
    
    # 4. ST-GNN
    stgnn_model = STGNN(seq_len=SEQ_LEN)
    stgnn_opt = torch.optim.Adam(stgnn_model.parameters(), lr=0.01)
    stgnn_mae, stgnn_rmse = train_model(stgnn_model, stgnn_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device)
    
    # Save ST-GNN weights
    model_path = os.path.join(os.path.dirname(__file__), "colombo_traffic_model_real.pth")
    torch.save(stgnn_model.state_dict(), model_path)
    
    # Output Benchmark Table
    print("\nEvaluating on Held-Out Chronological Test Set...")
    print("==========================================")
    print(f"{'Model':<22} | {'MAE (km/h)':<10} | {'RMSE (km/h)':<10}")
    print("------------------------------------------")
    print(f"{'Historical Average':<22} | {ha_mae:<10.2f} | {ha_rmse:<10.2f}")
    print(f"{'Pure GRU':<22} | {gru_mae:<10.2f} | {gru_rmse:<10.2f}")
    print(f"{'Pure GCN':<22} | {gcn_mae:<10.2f} | {gcn_rmse:<10.2f}")
    print(f"{'ST-GNN (Ours)':<22} | {stgnn_mae:<10.2f} | {stgnn_rmse:<10.2f}")
    print("==========================================\n")
    print(f"💾 Production weights saved to: {model_path}")

if __name__ == "__main__":
    main()
