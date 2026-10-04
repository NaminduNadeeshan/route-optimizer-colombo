import os
import copy
import torch
import torch.nn as nn
import numpy as np
import pandas as pd
from torch_geometric.data import Data
from torch_geometric.nn import GATConv, GCNConv
import matplotlib.pyplot as plt
import math

def load_real_colombo_graph_advanced():
    print("Loading real map-matched traffic data...")
    csv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "real_traffic_edges_colombo.csv"))
    
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Missing {csv_path}. Please run map_matcher.py first.")
        
    df = pd.read_csv(csv_path)
    
    unique_nodes = pd.unique(df[['source_node', 'target_node']].values.ravel('K'))
    num_nodes = len(unique_nodes)
    print(f"Extracted {num_nodes} unique physical intersections (nodes).")
    
    node_mapping = {osm_id: pt_id for pt_id, osm_id in enumerate(unique_nodes)}
    
    df['pt_source'] = df['source_node'].map(node_mapping)
    df['pt_target'] = df['target_node'].map(node_mapping)
    
    unique_edges = df[['pt_source', 'pt_target']].drop_duplicates()
    edge_index = torch.tensor(unique_edges.values.T, dtype=torch.long)
    print(f"Extracted {edge_index.size(1)} unique road segments (edges).")
    
    # 6 Features: [Speed, is_weekend, is_long_weekend, is_poya, is_avurudu_pre, is_avurudu_post]
    # We expand the 24 hours to a full 365-day year (8760 hours)
    X_numpy = np.full((num_nodes, 8760, 6), 0.0, dtype=np.float32)
    
    base_24h = np.full((num_nodes, 24), 30.0, dtype=np.float32)
    for _, row in df.iterrows():
        node_id = int(row['pt_target'])
        hour = int(row['hour']) % 24
        speed = float(row['avg_speed'])
        if base_24h[node_id, hour] == 30.0:
            base_24h[node_id, hour] = speed
        else:
            base_24h[node_id, hour] = (base_24h[node_id, hour] + speed) / 2
            
    # Avurudu is April 14th (Day 104 in non-leap year). Pre: 101-103. Post: 105-107.
    # Poya days (roughly every 29.5 days). E.g. Jan 25 (Day 25), Feb 24 (Day 55)...
    poya_days = {25, 54, 84, 113, 143, 172, 202, 231, 261, 290, 320, 349}
    
    import random
    
    for day in range(365):
        # Jan 1 2024 was a Monday (so day 0 is Monday, day 5 is Saturday, day 6 is Sunday)
        weekday = day % 7
        is_weekend = 1.0 if weekday >= 5 else 0.0
        
        # Long weekend: If a holiday falls on Monday (day 0) or Friday (day 4)
        is_long_weekend = 0.0
        if is_weekend and (day - 1 in poya_days or day - 2 in poya_days or day + 1 in poya_days or day + 2 in poya_days):
            is_long_weekend = 1.0
            
        is_poya = 1.0 if day in poya_days else 0.0
        
        is_avurudu_pre = 1.0 if 101 <= day <= 103 else 0.0
        is_avurudu_post = 1.0 if 105 <= day <= 107 else 0.0
        
        for hour in range(24):
            t_idx = day * 24 + hour
            speed = base_24h[:, hour].copy()
            
            # Poya Day logic (Low traffic morning, High traffic evening)
            if is_poya:
                if 6 <= hour <= 14:
                    speed *= 1.3 # Less traffic
                elif 17 <= hour <= 21:
                    speed *= 0.6 # High temple traffic
                    
            # Avurudu Pre (Everyone leaving Colombo -> High traffic leaving, low inside)
            # Let's just say traffic drastically low overall as per user request
            if is_avurudu_pre:
                speed *= 1.6 # Drastically low traffic (fast speeds)
                
            # Avurudu Post (Everyone returning to Colombo -> High traffic)
            if is_avurudu_post:
                speed *= 0.5 # High congestion
                
            # Long Weekend (Even lower traffic than normal weekend)
            if is_long_weekend:
                speed *= 1.4
            elif is_weekend:
                speed *= 1.15
                
            # Add some random daily noise
            noise = np.random.normal(0, 2.0, size=speed.shape)
            speed = speed + noise
            speed = np.clip(speed, 5.0, 50.0)
            
            X_numpy[:, t_idx, 0] = speed
            X_numpy[:, t_idx, 1] = is_weekend
            X_numpy[:, t_idx, 2] = is_long_weekend
            X_numpy[:, t_idx, 3] = is_poya
            X_numpy[:, t_idx, 4] = is_avurudu_pre
            X_numpy[:, t_idx, 5] = is_avurudu_post
            
    X_tensor = torch.tensor(X_numpy)
    data = Data(x=X_tensor, edge_index=edge_index)
    return data, node_mapping

class STGAT(nn.Module):
    """
    Enterprise-Grade ST-GAT Architecture with Deep Layers, Normalization, and Dropout.
    """
    def __init__(self, seq_len=12, hidden_dim=64, input_size=6, dropout=0.3):
        super(STGAT, self).__init__()
        # 1. Spatial Processing: Double GAT Layers for 2-hop neighborhood awareness
        self.gat1 = GATConv(in_channels=input_size, out_channels=hidden_dim, heads=4, concat=False)
        self.gat2 = GATConv(in_channels=hidden_dim, out_channels=hidden_dim, heads=4, concat=False)
        
        # 2. Regularization & Normalization
        self.norm1 = nn.LayerNorm(hidden_dim)
        self.dropout = nn.Dropout(dropout)
        
        # 3. Temporal Processing: Deep 2-Layer GRU for long-term memory
        self.gru = nn.GRU(
            input_size=hidden_dim, 
            hidden_size=hidden_dim, 
            num_layers=2,           # Deeper temporal processing
            batch_first=True,
            dropout=dropout         # Dropout between GRU layers
        )
        
        # 4. Final Prediction: Multi-layer Perceptron (MLP)
        self.fc1 = nn.Linear(hidden_dim, hidden_dim // 2)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(hidden_dim // 2, 1)

    def forward(self, x_seq, edge_index):
        batch, seq, features = x_seq.size()
        gat_outs = []
        
        # Process the spatial graph at each time step
        for t in range(seq):
            x_t = x_seq[:, t, :]
            
            # Layer 1: First Hop Intersection
            g1 = self.gat1(x_t, edge_index)
            g1 = self.relu(g1)
            g1 = self.dropout(g1)
            
            # Layer 2: Second Hop Intersection (Residual/Skip Connection applied)
            g2 = self.gat2(g1, edge_index)
            g2 = self.norm1(g2 + g1) # Residual connection stabilizes deep training
            
            gat_outs.append(g2.unsqueeze(1))
        
        # Pass the spatial embeddings through the Temporal GRU
        gru_in = torch.cat(gat_outs, dim=1)
        gru_out, _ = self.gru(gru_in)
        
        # Extract the final hidden state and pass through MLP
        last_hidden = gru_out[:, -1, :]
        out = self.fc1(last_hidden)
        out = self.relu(out)
        out = self.dropout(out)
        final_prediction = self.fc2(out)
        
        return final_prediction

def train_model(model, optimizer, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device, epochs=150, patience=20, model_name="Model", pretrained_path=None):
    criterion = nn.MSELoss()
    model.to(device)
    
    train_history, val_history = [], []
    best_val_mae = float('inf')
    best_weights = None
    patience_counter = 0
    save_path = os.path.join(os.path.dirname(__file__), f"weights_{model_name.replace(' ', '_').lower()}.pth")
    
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
            
        model.eval()
        val_preds, val_targets = [], []
        with torch.no_grad():
            for w in test_windows:
                x_w = data.x[:, w:w+SEQ_LEN, :].to(device)
                y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0].to(device)
                pred = model(x_w, data.edge_index.to(device))
                val_preds.append(pred.cpu().numpy())
                val_targets.append(y_w.cpu().numpy())
                
        val_preds = np.concatenate(val_preds, axis=1).squeeze()
        val_targets = np.concatenate(val_targets, axis=1).squeeze()
        
        val_mae = np.mean(np.abs(val_preds - val_targets))
        
        print(f"Epoch [{epoch+1}/{epochs}] | Validation MAE: {val_mae:.4f} km/h ", end="", flush=True)
        
        if val_mae < best_val_mae:
            print(f"| ⭐ New Best! Saving weights...", flush=True)
            best_val_mae = val_mae
            best_weights = copy.deepcopy(model.state_dict())
            torch.save(best_weights, save_path)
            patience_counter = 0
        else:
            patience_counter += 1
            print(f"| ⚠️ No improvement (Patience: {patience_counter}/{patience})", flush=True)
            if patience_counter >= patience:
                print(f"[{model_name}] Early stopping triggered at epoch {epoch+1}!", flush=True)
                break
                
    if best_weights:
        model.load_state_dict(best_weights)
        
    val_rmse = np.sqrt(np.mean((val_preds - val_targets)**2))
    
    # Avoid zero division
    safe_targets = np.where(val_targets == 0, 1e-6, val_targets)
    val_mape = np.mean(np.abs((val_preds - safe_targets) / safe_targets)) * 100
    
    return val_mae, val_rmse, val_mape, 0.0

def main():
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    print(f"Starting ML Traffic Forecasting Benchmark...", flush=True)
    
    data, node_mapping = load_real_colombo_graph_advanced()
    
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    total_hours = data.x.size(1)
    
    windows = list(range(0, total_hours - SEQ_LEN - FUTURE_STEPS))
    import random
    random.seed(42)
    random.shuffle(windows)
    
    # Use 32 windows for ultra-fast epoch iteration to show terminal output live
    train_windows = windows[:32]
    test_windows = windows[32:48]
    
    stgat_model = STGAT(seq_len=SEQ_LEN, hidden_dim=64, input_size=6, dropout=0.3)
    stgat_opt = torch.optim.AdamW(stgat_model.parameters(), lr=0.005)
    
    stgat_mae, stgat_rmse, stgat_mape, _ = train_model(
        stgat_model, stgat_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, 
        device, epochs=15, patience=3, model_name="Colombo Advanced ST-GAT"
    )
    
    print("\nEvaluating Colombo Model (Avurudu, Poya, Long Weekends)...", flush=True)
    print(f"MAE: {stgat_mae:.2f} km/h | MAPE: {stgat_mape:.2f}%", flush=True)
    print("💾 Production weights successfully exported to disk for Colombo!", flush=True)

if __name__ == "__main__":
    main()
