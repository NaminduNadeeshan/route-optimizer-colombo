import os
import torch
import argparse
import numpy as np
import pandas as pd
from datetime import datetime

def generate_osrm_traffic_csv(predictions, edge_index, reverse_mapping, output_path):
    print(f"Exporting predictions to {output_path}...")
    source_nodes_pt = edge_index[0].cpu().numpy()
    target_nodes_pt = edge_index[1].cpu().numpy()
    predicted_speeds = predictions[target_nodes_pt].squeeze().cpu().numpy()
    predicted_speeds = np.clip(predicted_speeds, a_min=5.0, a_max=120.0)
    source_osm = [reverse_mapping[node] for node in source_nodes_pt]
    target_osm = [reverse_mapping[node] for node in target_nodes_pt]
    df = pd.DataFrame({
        "from_node": source_osm,
        "to_node": target_osm,
        "speed": np.round(predicted_speeds).astype(int)
    })
    df.to_csv(output_path, index=False, header=False)
    print(f"Generated {len(df)} traffic edge updates for real OSM nodes!")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hour", type=int, default=9)
    parser.add_argument("--city", type=str, default="beijing")
    parser.add_argument("--date", type=str, default=None)
    args = parser.parse_args()
    
    is_weekend = 0.0
    is_holiday = 0.0
    is_long_weekend = 0.0
    is_poya = 0.0
    is_avurudu_pre = 0.0
    is_avurudu_post = 0.0
    
    if args.date:
        try:
            dt = datetime.strptime(args.date, "%Y-%m-%d")
            day_of_year = dt.timetuple().tm_yday
            weekday = dt.weekday()
            
            if weekday >= 5:
                is_weekend = 1.0
                print("📅 Recognized Planning Date as a WEEKEND.")
                
            poya_days = {25, 54, 84, 113, 143, 172, 202, 231, 261, 290, 320, 349}
            if day_of_year in poya_days:
                is_poya = 1.0
                print("🌕 Recognized Planning Date as a POYA DAY.")
                
            if is_weekend and (day_of_year - 1 in poya_days or day_of_year - 2 in poya_days or day_of_year + 1 in poya_days or day_of_year + 2 in poya_days):
                is_long_weekend = 1.0
                print("🏖️ Recognized Planning Date as a LONG WEEKEND.")
                
            if 101 <= day_of_year <= 103:
                is_avurudu_pre = 1.0
                print("🎆 Recognized Planning Date as AVURUDU OUTBOUND (Leaving Colombo).")
                
            if 105 <= day_of_year <= 107:
                is_avurudu_post = 1.0
                print("🚙 Recognized Planning Date as AVURUDU RETURN (Entering Colombo).")
                
            # Default holiday for Beijing compatibility
            if dt.month == 12 and dt.day == 25:
                is_holiday = 1.0
        except:
            pass

    print(f"Starting Dynamic OSRM Traffic Update Pipeline for {args.city} at {args.hour}:00...")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")
    
    if args.city == "colombo":
        osrm_map = "sri-lanka-latest.osrm"
        container_name = "route_osrm_colombo"
        weights = "weights_colombo_advanced_st-gat.pth"
        
        from train_stgnn_colombo_advanced import load_real_colombo_graph_advanced, STGAT
        data, node_mapping = load_real_colombo_graph_advanced()
        model = STGAT(seq_len=12, hidden_dim=16, input_size=6).to(device)
    else:
        osrm_map = "Beijing.osrm"
        container_name = "route_osrm_beijing"
        weights = "weights_st-gat_attention.pth"
        
        from train_stgnn import load_real_colombo_graph, STGAT
        data, node_mapping = load_real_colombo_graph()
        model = STGAT(seq_len=12, hidden_dim=128, future_steps=1).to(device)
        
    data = data.to(device)
    reverse_mapping = {v: k for k, v in node_mapping.items()}
    
    print(f"Loading trained ST-GAT Attention weights: {weights}...")
    model_path = os.path.join(os.path.dirname(__file__), weights)
    if os.path.exists(model_path):
        model.load_state_dict(torch.load(model_path, map_location=device), strict=False)
    else:
        print(f"⚠️ Warning: Could not find {model_path}.")
        
    model.eval()
    
    print(f"Predicting traffic congestion for Hour: {args.hour}:00...")
    with torch.no_grad():
        shifts = 24 - args.hour
        rolled_x = torch.roll(data.x, shifts=shifts, dims=1)
        x_window = rolled_x[:, -12:, :].clone()
        
        # Inject the real-time flags into the temporal sequence
        x_window[:, :, 1] = is_weekend
        if args.city == "colombo":
            x_window[:, :, 0] = x_window[:, :, 0] / 50.0
            x_window[:, :, 2] = is_long_weekend
            x_window[:, :, 3] = is_poya
            x_window[:, :, 4] = is_avurudu_pre
            x_window[:, :, 5] = is_avurudu_post
        else:
            x_window[:, :, 2] = is_holiday
            
        future_predictions = model(x_window, data.edge_index)
        if args.city == "colombo":
            future_predictions = future_predictions * 50.0
        
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
    os.makedirs(data_dir, exist_ok=True)
    traffic_csv_path = os.path.join(data_dir, f"traffic_{args.city}.csv")
    
    generate_osrm_traffic_csv(future_predictions, data.edge_index, reverse_mapping, traffic_csv_path)
    
    print(f"\nHot-Reloading {container_name} with new traffic predictions...")
    osrm_command = f"docker exec {container_name} osrm-customize /data/{osrm_map} --segment-speed-file /data/traffic_{args.city}.csv"
    print(f"Executing: {osrm_command}")
    
    exit_code = os.system(osrm_command)
    if exit_code == 0:
        print(f"Restarting {container_name} to load customized graph into RAM...")
        os.system(f"docker restart {container_name}")
        print("\nOSRM Routing Graph Successfully Updated!")

if __name__ == "__main__":
    main()
