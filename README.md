# 🚙 Open-Source Time-Travel Route Optimizer

A full-stack, enterprise-grade route optimization engine powered by a custom **Spatio-Temporal Graph Neural Network (ST-GNN)**. This system predicts future traffic congestion and uses the VROOM engine to optimally schedule fleet deliveries.

---

## 🚀 Advanced Machine Learning Pipeline

Our ML backend transitions basic historical averages into state-of-the-art predictive physics using PyTorch Geometric.

### 🧠 Model Architecture: ST-GAT
The core traffic prediction engine has been heavily upgraded to an **ST-GAT (Spatio-Temporal Graph Attention Network)**:
1. **Deeper Temporal Gating**: 2-Layer `nn.GRU` (Hidden: 128) processes historical sequences, capturing morning/evening rush hour dynamics.
2. **Spatial Attention (`GATv2Conv`)**: Instead of basic convolutions, the model dynamically learns *which* intersections and incoming roads matter most, weighing bottlenecks across the topological OpenStreetMap graph.
3. **Automated Checkpointing**: Built-in early stopping automatically monitors validation loss, halting training to prevent overfitting and cleanly extracting the highest-performing `.pth` weights.

### 🌍 Cross-City Transfer Learning (Warm Start)
We implemented automated **Transfer Learning**. Traffic behaves similarly worldwide (bottlenecks cause ripples). You can pre-train the model on massive 15-Million point datasets in Beijing, and then seamlessly inject those deep structural weights into your local city's map. 
The pipeline uses `strict=False` loading to transfer the universal GRU/GAT layers while ignoring graph-size differences!

## 📊 Supported Open Datasets

The pipeline natively parses several of the world's most robust open-source traffic datasets for testing and pre-training:

1. **Microsoft T-Drive (Beijing)**:
   * 15 Million raw GPS trajectories across a dense urban grid.
   * Native parsing adapter inside `map_matcher.py`.
2. **PeMS04 (California Highways)**:
   * Included native benchmarking script (`train_pems04.py`) that strictly processes static `.npz` highway sensor arrays, entirely bypassing OSRM for direct architecture benchmarking.
3. **Porto Taxi Dataset (Portugal)**:
   * 1.7 Million European trajectories. Accessible via the included `download_porto_hub.py` script.

## 🗺️ How it Works (End-to-End)

1. **Telemetry Ingestion**: `map_matcher.py` reads raw `[lon, lat, timestamp]` datasets (e.g. T-Drive) and hits the OSRM `/match` engine to aggressively snap GPS noise to the true physical nodes in your `.osm.pbf` map.
2. **Edge Extraction**: The matcher extracts continuous driving trips and calculates the exact traversal durations, saving a chronological matrix to `real_traffic_edges.csv`.
3. **Training**: `train_stgnn.py` builds the spatial edge-index and trains the ST-GAT model on the true traffic physics.
4. **Time-Travel Optimization**: The FastAPI backend bridges the PyTorch model to the VROOM solver. If a delivery route takes 5 hours, the backend queries the neural network to hot-reload OSRM's traffic weights for the future hours!

## 🚀 Quick Start

### 1. Requirements
* Docker & Docker Compose
* Python 3.10+
* PostGIS

### 2. Launch Core Services
```bash
docker-compose up -d
```
This spins up the PostgreSQL DB, the OSRM Routing Engine, the VROOM Solver, and the FastAPI backend.

### 3. Start the ML Time-Travel Bridge
Because PyTorch requires host-level GPU drivers (MPS/CUDA), the ML bridge runs outside of Docker:
```bash
cd ml-pipeline
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn ml_api:app --host 0.0.0.0 --port 8001
```

### 4. Access the Dashboard
Navigate to `http://localhost:8000` to access the interactive web UI. Drop pins on the map, set your Start Time and Deadline, and click Optimize.
