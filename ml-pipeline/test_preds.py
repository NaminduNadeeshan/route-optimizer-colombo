import torch
import numpy as np
import argparse
from train_stgnn import STGNN, load_real_colombo_graph

def check(hour):
    data, mapping = load_real_colombo_graph()
    device = torch.device("cpu")
    data = data.to(device)
    model = STGNN(seq_len=12, hidden_dim=64, future_steps=1).to(device)
    model.load_state_dict(torch.load("colombo_traffic_model_real.pth", map_location=device, weights_only=True))
    model.eval()
    with torch.no_grad():
        shifts = 24 - hour
        rolled_x = torch.roll(data.x, shifts=shifts, dims=1)
        x_window = rolled_x[:, -12:, :]
        preds = model(x_window, data.edge_index)
        speeds = preds[data.edge_index[1]].squeeze().cpu().numpy()
        print(f"Hour {hour} mean speed: {np.mean(speeds):.2f}, std: {np.std(speeds):.2f}")

check(0)
check(9)
