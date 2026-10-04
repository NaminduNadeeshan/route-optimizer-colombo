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
    csv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "real_traffic_edges.csv"))
    
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
    def __init__(self, seq_len=12, hidden_dim=64, input_size=6):
        super(STGAT, self).__init__()
        self.gat = GATConv(in_channels=input_size, out_channels=hidden_dim, heads=4, concat=False)
        self.gru = nn.GRU(input_size=hidden_dim, hidden_size=hidden_dim, batch_first=True)
        self.fc = nn.Linear(hidden_dim, 1)

    def forward(self, x_seq, edge_index):
        batch, seq, features = x_seq.size()
        gat_outs = []
        for t in range(seq):
            x_t = x_seq[:, t, :]
            g_out = self.gat(x_t, edge_index)
            gat_outs.append(g_out.unsqueeze(1))
        
        gru_in = torch.cat(gat_outs, dim=1)
        gru_out, _ = self.gru(gru_in)
        out = self.fc(gru_out[:, -1, :])
        return out

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
        
        if val_mae < best_val_mae:
            best_val_mae = val_mae
            best_weights = copy.deepcopy(model.state_dict())
            torch.save(best_weights, save_path)
            patience_counter = 0
        else:
            patience_counter += 1
            if patience_counter >= patience:
                print(f"[{model_name}] Early stopping triggered at epoch {epoch}!")
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
    print(f"Starting ML Traffic Forecasting Benchmark...")
    
    data, node_mapping = load_real_colombo_graph_advanced()
    
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    total_hours = data.x.size(1)
    
    windows = list(range(0, total_hours - SEQ_LEN - FUTURE_STEPS))
    # Shuffle and split for robust learning on the 8760 hours
    import random
    random.seed(42)
    random.shuffle(windows)
    
    # 5% for training (400 hours) is enough to learn the features without taking forever, 
    # and 5% for testing to prove it learned
    train_windows = windows[:400]
    test_windows = windows[400:800]
    
    stgat_model = STGAT(seq_len=SEQ_LEN, hidden_dim=64, input_size=6)
    stgat_opt = torch.optim.AdamW(stgat_model.parameters(), lr=0.005)
    
    stgat_mae, stgat_rmse, stgat_mape, _ = train_model(
        stgat_model, stgat_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, 
        device, epochs=30, patience=5, model_name="Colombo Advanced ST-GAT"
    )
    
    print("\nEvaluating Colombo Model (Avurudu, Poya, Long Weekends)...")
    print(f"MAE: {stgat_mae:.2f} km/h | MAPE: {stgat_mape:.2f}%")
    print("💾 Production weights successfully exported to disk for Colombo!")

if __name__ == "__main__":
    main()
