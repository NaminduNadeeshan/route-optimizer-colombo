"""
Export model metrics for the project website.

Evaluates the trained Colombo ST-GAT (weights_colombo_advanced_st-gat.pth) on
fresh synthetic days drawn from the same generator used in training, one day
per calendar scenario, for every hour. Also replays the exact inference path
used by update_osrm_traffic.py to show how much the deployed prediction
actually changes with the planning date.

The synthetic generator below mirrors load_real_colombo_graph_advanced() in
train_stgnn_colombo_advanced.py, but only builds the hours it needs instead of
the full (nodes x 8760 x 6) tensor. Keep the two in sync.

Usage:
    python export_site_metrics.py --out /path/to/site/assets/model-metrics.js
"""
import os
import json
import argparse
import numpy as np
import pandas as pd
import torch

from train_stgnn_colombo_advanced import STGAT

HERE = os.path.dirname(os.path.abspath(__file__))
EDGES_CSV = os.path.join(HERE, "..", "data", "real_traffic_edges_colombo.csv")
WEIGHTS = os.path.join(HERE, "weights_colombo_advanced_st-gat.pth")

POYA_DAYS = {25, 54, 84, 113, 143, 172, 202, 231, 261, 290, 320, 349}
NOISE_STD = 2.0
SEQ_LEN = 12

# Training-generator day indices (0-based, day 0 = Mon 1 Jan 2024).
SCENARIOS = [
    {"key": "weekday", "label": "Weekday", "day": 8},            # Tue 9 Jan
    {"key": "weekend", "label": "Weekend", "day": 12},           # Sat 13 Jan
    {"key": "long_weekend", "label": "Long weekend", "day": 55}, # Sun 25 Feb, next to Poya
    {"key": "poya", "label": "Poya (weekday)", "day": 84},       # Mon 25 Mar
    {"key": "avurudu_pre", "label": "Avurudu outbound", "day": 102},  # Fri 12 Apr
    {"key": "avurudu_post", "label": "Avurudu return", "day": 106},   # Tue 16 Apr
]


def day_flags(d):
    day_of_year = d + 1
    weekday = (day_of_year - 1) % 7
    is_weekend = 1.0 if weekday >= 5 else 0.0
    is_long_weekend = 0.0
    if is_weekend and (day_of_year - 1 in POYA_DAYS or day_of_year - 2 in POYA_DAYS or day_of_year + 1 in POYA_DAYS or day_of_year + 2 in POYA_DAYS):
        is_long_weekend = 1.0
    is_poya = 1.0 if day_of_year in POYA_DAYS else 0.0
    is_pre = 1.0 if 101 <= day_of_year <= 103 else 0.0
    is_post = 1.0 if 105 <= day_of_year <= 107 else 0.0
    return [is_weekend, is_long_weekend, is_poya, is_pre, is_post]


def generator_mean(base_24h, day, hour):
    """Noise-free speed the generator would produce (the best any model can do)."""
    is_weekend, is_long_weekend, is_poya, is_pre, is_post = day_flags(day)
    speed = base_24h[:, hour].copy()
    if is_poya:
        if 6 <= hour <= 14:
            speed *= 1.3
        elif 17 <= hour <= 21:
            speed *= 0.6
    if is_pre:
        speed *= 1.6
    if is_post:
        speed *= 0.5
    if is_long_weekend:
        speed *= 1.4
    elif is_weekend:
        speed *= 1.15
    return np.clip(speed, 5.0, 50.0)


def sample_speed(base_24h, day, hour, rng):
    mean = generator_mean(base_24h, day, hour)
    return np.clip(mean + rng.normal(0, NOISE_STD, size=mean.shape), 5.0, 50.0).astype(np.float32)


def build_window(base_24h, t_abs, rng, flag_override=None):
    """12 hours ending just before absolute hour t_abs -> (nodes, 12, 6)."""
    n = base_24h.shape[0]
    x = np.zeros((n, SEQ_LEN, 6), dtype=np.float32)
    for j, k in enumerate(range(t_abs - SEQ_LEN, t_abs)):
        d, h = k // 24, k % 24
        x[:, j, 0] = sample_speed(base_24h, d, h, rng) / 50.0
        x[:, j, 1:] = flag_override if flag_override is not None else day_flags(d)
    return x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rng = np.random.default_rng(0)
    torch.manual_seed(0)
    device = torch.device("cpu")

    df = pd.read_csv(EDGES_CSV)
    unique_nodes = pd.unique(df[["source_node", "target_node"]].values.ravel("K"))
    node_mapping = {osm: i for i, osm in enumerate(unique_nodes)}
    df["pt_source"] = df["source_node"].map(node_mapping)
    df["pt_target"] = df["target_node"].map(node_mapping)
    edges = df[["pt_source", "pt_target"]].drop_duplicates()
    edge_index = torch.tensor(edges.values.T, dtype=torch.long)
    n_nodes = len(unique_nodes)

    base_24h = np.full((n_nodes, 24), np.nan, dtype=np.float32)
    for _, row in df.iterrows():
        nid, hour, spd = int(row["pt_target"]), int(row["hour"]) % 24, float(row["avg_speed"])
        if np.isnan(base_24h[nid, hour]):
            base_24h[nid, hour] = spd
        else:
            base_24h[nid, hour] = (base_24h[nid, hour] + spd) / 2

    curve_multipliers = np.array([
        1.3, 1.3, 1.4, 1.4, 1.4, 1.2,
        1.0, 0.6, 0.5, 0.7, 0.9, 0.9,
        0.9, 0.9, 0.9, 0.9, 0.7, 0.5,
        0.5, 0.6, 0.8, 1.0, 1.1, 1.2
    ])
    for i in range(n_nodes):
        observed = base_24h[i, ~np.isnan(base_24h[i])]
        mean_spd = np.mean(observed) if len(observed) > 0 else 30.0
        for h in range(24):
            if np.isnan(base_24h[i, h]):
                base_24h[i, h] = mean_spd * curve_multipliers[h]

    model = STGAT(seq_len=SEQ_LEN, hidden_dim=16, input_size=6, dropout=0.3)
    state = torch.load(WEIGHTS, map_location=device)
    model.load_state_dict(state, strict=True)
    model.eval()

    # Parameter counts per block
    blocks = {}
    for name, p in model.named_parameters():
        blocks.setdefault(name.split(".")[0], 0)
        blocks[name.split(".")[0]] += p.numel()
    total_params = sum(blocks.values())

    scen_out, all_resid = [], []
    with torch.no_grad():
        for sc in SCENARIOS:
            rows = []
            for hour in range(24):
                t_abs = sc["day"] * 24 + hour
                x = build_window(base_24h, t_abs, rng)
                target = sample_speed(base_24h, sc["day"], hour, rng)
                pred = model(torch.from_numpy(x), edge_index).squeeze(1).numpy() * 50.0
                best = generator_mean(base_24h, sc["day"], hour)
                persist = x[:, -1, 0]
                blind = base_24h[:, hour]  # same hour, calendar ignored
                resid = pred - target
                all_resid.append(resid)
                rows.append({
                    "hour": hour,
                    "pred_mean": float(pred.mean()),
                    "target_mean": float(target.mean()),
                    "best_mean": float(best.mean()),
                    "mae": float(np.abs(resid).mean()),
                    "mae_persistence": float(np.abs(persist - target).mean()),
                    "mae_calendar_blind": float(np.abs(blind - target).mean()),
                    "mae_generator_mean": float(np.abs(best - target).mean()),
                })
            scen_out.append({
                "key": sc["key"], "label": sc["label"], "day": sc["day"],
                "flags": day_flags(sc["day"]),
                "hours": rows,
                "mae": float(np.mean([r["mae"] for r in rows])),
                "mae_persistence": float(np.mean([r["mae_persistence"] for r in rows])),
                "mae_calendar_blind": float(np.mean([r["mae_calendar_blind"] for r in rows])),
                "mae_generator_mean": float(np.mean([r["mae_generator_mean"] for r in rows])),
            })
            print(f"{sc['label']:<18} target mean: {np.mean([r['target_mean'] for r in rows]):.2f} MAE {scen_out[-1]['mae']:.2f}  persistence {scen_out[-1]['mae_persistence']:.2f}  "
                  f"calendar-blind {scen_out[-1]['mae_calendar_blind']:.2f}  floor {scen_out[-1]['mae_generator_mean']:.2f}", flush=True)

        # Replay update_osrm_traffic.py: history window always comes from the end of the
        # synthetic year (day 364); only the 5 calendar flags are swapped for the planning date.
        deploy = []
        for sc in SCENARIOS:
            flags = day_flags(sc["day"])
            means = []
            for hour in range(24):
                t_abs = 364 * 24 + hour
                x = build_window(base_24h, t_abs, rng, flag_override=flags)
                pred = model(torch.from_numpy(x), edge_index).squeeze(1).numpy() * 50.0
                means.append(float(pred.mean()))
            deploy.append({"key": sc["key"], "label": sc["label"], "pred_mean": means})
            print(f"deploy-path {sc['label']:<18} mean pred {np.mean(means):.2f} km/h", flush=True)

    resid = np.concatenate(all_resid)
    edges_hist = np.arange(-12, 12.5, 1.0)
    counts, _ = np.histogram(np.clip(resid, -12, 12), bins=edges_hist)

    out = {
        "generated_by": "ml-pipeline/export_site_metrics.py",
        "graph": {"nodes": int(n_nodes), "edges": int(edge_index.size(1))},
        "params": {"total": int(total_params), "blocks": blocks},
        "noise_std": NOISE_STD,
        "training_log": {
            "source": "train_stgnn_colombo_advanced.py run, 4 Oct 2026",
            "val_mae": [4.0563, 3.3957, 3.2648, 3.2653, 3.2645, 3.2655, 3.2700, 3.2715],
            "best_epoch": 5, "stopped_epoch": 8,
            "final": {"mae": 3.27, "mape": 9.23},
            "train_windows": 32, "val_windows": 16,
        },
        "earlier_benchmark": {
            "source": "3-feature model, earlier version (ml_performance_report)",
            "rows": [
                {"model": "Historical average", "mae": 2.44, "rmse": 3.43, "mape": 6.70},
                {"model": "GRU only", "mae": 3.78, "rmse": 4.49, "mape": 10.54},
                {"model": "ST-GNN (GCN + GRU)", "mae": 3.73, "rmse": 4.44, "mape": 10.39},
                {"model": "ST-GAT (GAT + GRU)", "mae": 3.44, "rmse": 4.20, "mape": 9.55},
            ],
        },
        "scenarios": scen_out,
        "deploy_path": deploy,
        "residuals": {"bin_edges": edges_hist.tolist(), "counts": counts.tolist(),
                      "mean": float(resid.mean()), "std": float(resid.std())},
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        f.write("/* Generated by ml-pipeline/export_site_metrics.py. Do not edit by hand. */\n")
        f.write("window.MODEL_METRICS = ")
        json.dump(out, f, indent=1)
        f.write(";\n")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
