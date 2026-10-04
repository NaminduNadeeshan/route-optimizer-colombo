import os
import torch
import numpy as np
from torch_geometric.data import Data
from train_stgnn import STGAT, train_model

def load_pems04_data():
    print("📥 Loading PeMS04 California Highway Data...")
    pems_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "datasets", "pems04.npz"))
    
    if not os.path.exists(pems_path):
        raise FileNotFoundError(f"Missing {pems_path}.")
        
    data_dict = np.load(pems_path)
    # PeMS04 is typically shape (sequence_length, num_nodes, num_features)
    raw_data = data_dict['data'] 
    print(f"PeMS04 Raw Shape: {raw_data.shape}")
    
    # We want features to be speed/flow. 
    # Reshape to match our STGNN expectation: (num_nodes, sequence_length, features)
    X_numpy = np.transpose(raw_data[..., 0:1], (1, 0, 2))
    # Standardize data roughly to avoid exploding gradients if numbers are huge
    mean = np.mean(X_numpy)
    std = np.std(X_numpy)
    X_numpy = (X_numpy - mean) / (std + 1e-5)
    
    X_tensor = torch.tensor(X_numpy, dtype=torch.float32)
    
    # Create a simple fully connected adjacency for benchmarking (or use distance matrix if available)
    num_nodes = X_tensor.size(0)
    print(f"Extracted {num_nodes} unique sensor nodes.")
    
    # For a quick benchmark, we create a linear sequential edge index 
    # (In a real paper, you load the accompanying distance.csv matrix)
    edges = []
    for i in range(num_nodes - 1):
        edges.append([i, i+1])
        edges.append([i+1, i])
    edge_index = torch.tensor(edges, dtype=torch.long).t().contiguous()
    
    data = Data(x=X_tensor, edge_index=edge_index)
    return data, mean, std

if __name__ == "__main__":
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    data, mean, std = load_pems04_data()
    
    SEQ_LEN = 12
    FUTURE_STEPS = 1
    
    # Take a slice of time for quick benchmarking (e.g. first 2000 hours)
    total_hours = min(data.x.size(1), 2000)
    windows_count = total_hours - SEQ_LEN - FUTURE_STEPS
    
    split_idx = int(windows_count * 0.7)
    train_windows = list(range(0, split_idx))
    test_windows = list(range(split_idx, windows_count))
    
    print("🚀 Training ST-GAT on California Highway Dataset (PeMS04)...")
    stgat_model = STGAT(seq_len=SEQ_LEN, hidden_dim=64)
    stgat_opt = torch.optim.AdamW(stgat_model.parameters(), lr=0.005)
    
    mae, rmse, mape, r2 = train_model(
        stgat_model, stgat_opt, data, train_windows, test_windows, SEQ_LEN, FUTURE_STEPS, 
        device, epochs=50, patience=10, model_name="PeMS04 ST-GAT"
    )
    
    # Rescale MAE back to original units
    real_mae = mae * std
    print("\n=========================================================================")
    print(f"PeMS04 ST-GAT Result | Unscaled MAE: {real_mae:.2f}")
    print("=========================================================================\n")
    print("💾 Saved California weights successfully!")
