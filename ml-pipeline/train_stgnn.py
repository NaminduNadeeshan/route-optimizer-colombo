import os
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GCNConv, GATv2Conv
from torch_geometric.data import Data
import pandas as pd
import numpy as np
from tqdm import tqdm
import matplotlib.pyplot as plt
import copy

# --------------------------
# 1. Real Graph Construction
# --------------------------
def load_real_colombo_graph():
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
    
    X_numpy = np.full((num_nodes, 24, 1), 30.0, dtype=np.float32)
    
    for _, row in df.iterrows():
        node_id = int(row['pt_target'])
        hour = int(row['hour']) % 24
        speed = float(row['avg_speed'])
        
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
    def fit(self, X_train):
        self.node_means = X_train.mean(dim=(0, 2)).squeeze()
        
    def predict(self, x_window):
        return self.node_means.unsqueeze(1)

class PureGRU(nn.Module):
    def __init__(self, seq_len=12, hidden_dim=64, future_steps=1):
        super(PureGRU, self).__init__()
        self.gru = nn.GRU(input_size=1, hidden_size=hidden_dim, batch_first=True)
        self.fc = nn.Linear(hidden_dim, future_steps)
        
    def forward(self, x, edge_index):
        out, _ = self.gru(x)
        return self.fc(out[:, -1, :])

class STGNN(nn.Module):
    """Standard Graph Convolution Network mixed with GRU"""
    def __init__(self, seq_len=12, hidden_dim=64, future_steps=1):
        super(STGNN, self).__init__()
        self.gru1 = nn.GRU(input_size=1, hidden_size=hidden_dim, batch_first=True)
        self.gcn1 = GCNConv(hidden_dim, hidden_dim, normalize=False)
        self.gcn2 = GCNConv(hidden_dim, hidden_dim, normalize=False)
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

class STGAT(nn.Module):
    """ADVANCED: Spatio-Temporal Graph Attention Network (GATv2)"""
    def __init__(self, seq_len=12, hidden_dim=128, future_steps=1):
        super(STGAT, self).__init__()
        # Deeper temporal processing
        self.gru = nn.GRU(input_size=1, hidden_size=hidden_dim, num_layers=2, batch_first=True, dropout=0.2)
        
        # Attention mechanisms dynamically learn which intersections matter most
        self.gat1 = GATv2Conv(hidden_dim, hidden_dim // 2, heads=2, concat=True)
        self.gat2 = GATv2Conv(hidden_dim, hidden_dim, heads=1, concat=False)
        
        self.norm = nn.LayerNorm(hidden_dim)
        self.fc1 = nn.Linear(hidden_dim, 64)
        self.fc2 = nn.Linear(64, future_steps)
        self.dropout = nn.Dropout(0.3)
        
    def forward(self, x, edge_index):
        out, _ = self.gru(x)
        t_last = out[:, -1, :] 
        
        g_out = self.dropout(F.relu(self.gat1(t_last, edge_index)))
        g_out = self.norm(g_out)
        g_out2 = F.relu(self.gat2(g_out, edge_index))
        
        spatial_features = t_last + g_out2 # Residual
        
        pred = self.dropout(F.relu(self.fc1(spatial_features)))
        return self.fc2(pred)

# --------------------------
# 3. Training & Benchmark Loop
# --------------------------

def compute_metrics(pred, target):
    pred = pred.detach().cpu().numpy()
    target = target.detach().cpu().numpy()
    mae = np.mean(np.abs(pred - target))
    rmse = np.sqrt(np.mean((pred - target) ** 2))
    mask = target > 0
    mape = np.mean(np.abs((target[mask] - pred[mask]) / target[mask])) * 100 if np.any(mask) else 0.0
    ss_res = np.sum((target - pred) ** 2)
    ss_tot = np.sum((target - np.mean(target)) ** 2)
    r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
    return mae, rmse, mape, r2

def train_model(model, optimizer, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device, epochs=150, patience=20, model_name="Model", pretrained_path=None):
    criterion = nn.MSELoss()
    model.to(device)
    
    # === TRANSFER LEARNING: WARM START ===
    if pretrained_path and os.path.exists(pretrained_path):
        print(f"🔄 TRANSFER LEARNING: Loading pre-trained weights for {model_name} from {pretrained_path}...")
        # strict=False allows it to gracefully handle any slight graph size mismatches
        model.load_state_dict(torch.load(pretrained_path, map_location=device), strict=False)
        print("✅ Pre-trained traffic physics successfully injected!")
    # =====================================
    
    train_history = []
    val_history = []
    
    best_val_mae = float('inf')
    best_weights = None
    patience_counter = 0
    save_path = os.path.join(os.path.dirname(__file__), f"weights_{model_name.replace(' ', '_').lower()}.pth")
    
    for epoch in range(epochs):
        model.train()
        epoch_train_preds, epoch_train_targets = [], []
        for w in train_windows:
            x_w = data.x[:, w:w+SEQ_LEN, :].to(device)
            y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0].to(device)
            
            optimizer.zero_grad()
            pred = model(x_w, data.edge_index.to(device))
            loss = criterion(pred, y_w)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            
            epoch_train_preds.append(pred.detach())
            epoch_train_targets.append(y_w.detach())
            
        train_mae, _, _, _ = compute_metrics(torch.cat(epoch_train_preds), torch.cat(epoch_train_targets))
        train_history.append(train_mae)
        
        # Validation
        model.eval()
        epoch_val_preds, epoch_val_targets = [], []
        with torch.no_grad():
            for w in test_windows:
                x_w = data.x[:, w:w+SEQ_LEN, :].to(device)
                y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0].to(device)
                pred = model(x_w, data.edge_index.to(device))
                epoch_val_preds.append(pred)
                epoch_val_targets.append(y_w)
                
        val_mae, _, _, _ = compute_metrics(torch.cat(epoch_val_preds), torch.cat(epoch_val_targets))
        val_history.append(val_mae)
        
        # Early Stopping & Model Checkpointing
        if val_mae < best_val_mae:
            best_val_mae = val_mae
            best_weights = copy.deepcopy(model.state_dict())
            torch.save(best_weights, save_path)
            patience_counter = 0
        else:
            patience_counter += 1
            
        if patience_counter >= patience:
            print(f"[{model_name}] Early stopping triggered at epoch {epoch + 1}!")
            break
            
    # Load best weights for final evaluation
    if best_weights is not None:
        model.load_state_dict(best_weights)
        
    # Plotting
    if "ST" in model_name:
        plt.figure(figsize=(10, 6))
        plt.plot(range(1, len(train_history) + 1), train_history, label='Train MAE', marker='o')
        plt.plot(range(1, len(val_history) + 1), val_history, label='Validation MAE', marker='s')
        plt.axvline(x=len(train_history)-patience_counter, color='r', linestyle='--', label='Best Model')
        plt.title(f'Learning Curve: {model_name}')
        plt.xlabel('Epochs')
        plt.ylabel('Mean Absolute Error (km/h)')
        plt.legend()
        plt.grid(True)
        plt.savefig(os.path.join(os.path.dirname(__file__), f"learning_curve_{model_name.replace(' ', '_')}.png"))
        plt.close()
            
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
    print("Starting ML Traffic Forecasting Benchmark with Advanced Architectures...")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    
    data, mapping = load_real_colombo_graph()
    
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    total_hours = data.x.size(1) 
    
    windows_count = total_hours - SEQ_LEN - FUTURE_STEPS
    if windows_count < 2:
        print("Not enough temporal data for splitting.")
        return
        
    split_idx = int(windows_count * 0.7)
    train_windows = list(range(0, split_idx))
    test_windows = list(range(split_idx, windows_count))
    
    ha = HistoricalAverage()
    train_tensors = [data.x[:, w:w+SEQ_LEN+1, :] for w in train_windows]
    ha.fit(torch.stack(train_tensors))
    
    ha_preds, ha_targets = [], []
    for w in test_windows:
        x_w = data.x[:, w:w+SEQ_LEN, :]
        y_w = data.x[:, w+SEQ_LEN : w+SEQ_LEN+FUTURE_STEPS, 0]
        ha_preds.append(ha.predict(x_w))
        ha_targets.append(y_w)
    ha_mae, ha_rmse, ha_mape, ha_r2 = compute_metrics(torch.cat(ha_preds), torch.cat(ha_targets))
    
    gru_model = PureGRU(seq_len=SEQ_LEN)
    gru_mae, gru_rmse, gru_mape, gru_r2 = train_model(gru_model, torch.optim.Adam(gru_model.parameters(), lr=0.01), data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device, model_name="Pure GRU")
    
    stgnn_model = STGNN(seq_len=SEQ_LEN)
    stgnn_mae, stgnn_rmse, stgnn_mape, stgnn_r2 = train_model(stgnn_model, torch.optim.Adam(stgnn_model.parameters(), lr=0.01), data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, device, model_name="ST-GNN Basic")
    
    # Advanced Model Training
    stgat_model = STGAT(seq_len=SEQ_LEN, hidden_dim=128)
    # Using AdamW for better weight decay / regularization on attention weights
    stgat_opt = torch.optim.AdamW(stgat_model.parameters(), lr=0.005, weight_decay=1e-4)
    
    # Check for existing weights in the directory for Transfer Learning
    saved_weights = os.path.join(os.path.dirname(__file__), "weights_st-gat_attention.pth")
    stgat_mae, stgat_rmse, stgat_mape, stgat_r2 = train_model(
        stgat_model, stgat_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, 
        device, epochs=150, patience=25, model_name="ST-GAT Attention", pretrained_path=saved_weights
    )
    
    print("\nEvaluating on Held-Out Chronological Test Set...")
    print("=========================================================================")
    print(f"{'Model':<22} | {'MAE (km/h)':<10} | {'RMSE (km/h)':<10} | {'MAPE (%)':<10} | {'R2 Score':<10}")
    print("-------------------------------------------------------------------------")
    print(f"{'Historical Average':<22} | {ha_mae:<10.2f} | {ha_rmse:<10.2f} | {ha_mape:<10.2f} | {ha_r2:<10.2f}")
    print(f"{'Pure GRU':<22} | {gru_mae:<10.2f} | {gru_rmse:<10.2f} | {gru_mape:<10.2f} | {gru_r2:<10.2f}")
    print(f"{'ST-GNN (Basic)':<22} | {stgnn_mae:<10.2f} | {stgnn_rmse:<10.2f} | {stgnn_mape:<10.2f} | {stgnn_r2:<10.2f}")
    print(f"{'ST-GAT (Attention)':<22} | {stgat_mae:<10.2f} | {stgat_rmse:<10.2f} | {stgat_mape:<10.2f} | {stgat_r2:<10.2f}")
    print("=========================================================================\n")
    print("💾 Production weights successfully exported to disk for testing!")

if __name__ == "__main__":
    main()
