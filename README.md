# 🇱🇰 Open-Source Colombo Route Optimizer

A 100% free, enterprise-grade route optimization engine built specifically for the Sri Lankan logistics and delivery industry. Powered by a custom **Spatio-Temporal Graph Attention Network (ST-GAT)**, this system predicts future traffic congestion across Colombo and uses the VROOM engine to optimally schedule fleet deliveries.

---

## 🎯 Our Mission: Free AI for Sri Lankan Logistics
Commercial routing APIs (like Google Maps or Mapbox) are incredibly expensive for local startups, supply-chain operators, and fleet dispatchers. 

**Our ultimate goal is to provide the logistics industry with a state-of-the-art, 100% free alternative.** By combining OpenStreetMap topology with advanced Artificial Intelligence, this platform allows any delivery company to cut fuel costs, bypass traffic, and optimize dispatching without paying per-ping API routing fees.

---

## 🌍 The Strategy: Using Global Data for Local Accuracy
To make the Colombo model highly accurate, the AI needs millions of data points to learn how traffic bottlenecks form and disperse. Because highly granular, open-source GPS data for Colombo is currently sparse, we utilize **Global Transfer Learning**.

We leverage massive open-source datasets from around the world to *pre-train* the model's physics engine. We then seamlessly inject those deep structural weights into the Colombo map!

### Supported Pre-Training Datasets:
1. **Microsoft T-Drive (Beijing)**: 15 Million raw GPS trajectories. Used to teach the model how dense, urban grid traffic ripples across intersections.
2. **PeMS04 (California Highways)**: Used to teach the model high-speed highway congestion dynamics.
3. **Porto Taxi (Portugal)**: 1.7 Million trajectories used to understand chaotic, narrow urban routing.

*By pre-training on these global datasets, the model learns the universal laws of traffic. When you feed it your local Colombo fleet data, it adapts instantly using our `strict=False` warm-start architecture.*

---

## 🚀 Advanced Machine Learning Pipeline

Our ML backend transitions basic historical averages into state-of-the-art predictive physics using PyTorch Geometric.

### 🧠 Model Architecture: ST-GAT
1. **Deeper Temporal Gating**: 2-Layer `nn.GRU` (Hidden: 128) processes historical sequences, capturing morning/evening rush hour dynamics.
2. **Spatial Attention (`GATv2Conv`)**: Instead of basic convolutions, the model dynamically learns *which* intersections and incoming roads matter most, weighing bottlenecks across the topological OpenStreetMap graph.
3. **Automated Checkpointing**: Built-in early stopping automatically monitors validation loss, halting training to prevent overfitting and cleanly extracting the highest-performing `.pth` weights.

### 🇱🇰 Advanced Colombo Event Modeling (6-Feature Tensor)
The neural network has been upgraded to a 6-feature input tensor specifically engineered to model Sri Lanka's unique cultural and temporal traffic dynamics. The model natively learns and predicts variations based on:
- **Poya Days:** Modulates traffic to reflect empty morning streets but heavily congested evening roads (due to Bana/temple traffic).
- **Sinhala & Tamil New Year (Avurudu):** Explicitly flags the April 11-13 outbound exodus (drastic city traffic reduction) and the April 15-17 inbound return rush (severe congestion).
- **Long Weekends:** Detects when a holiday borders a weekend, mathematically modeling the massive traffic drop compared to a standard weekend.
- **Dynamic API Bridge:** The frontend UI Date Picker passes the exact planning date to the Python backend, which automatically extracts these holidays and feeds them directly into the PyTorch inference tensor.

## 🗺️ How it Works (End-to-End)

1. **Telemetry Ingestion**: `map_matcher.py` reads raw `[lon, lat, timestamp]` datasets and hits the OSRM `/match` engine to aggressively snap GPS noise to the true physical nodes in your `.osm.pbf` map.
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
