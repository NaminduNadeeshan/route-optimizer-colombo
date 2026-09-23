# Delivery Route Optimizer (Colombo)

An AI-powered, time-aware logistics routing engine built for last-mile delivery operations in Colombo, Sri Lanka. This engine replaces static routing by integrating a Spatio-Temporal Graph Neural Network (ST-GNN) that dynamically predicts city-wide traffic congestion, injecting those predictions into an OpenStreetMap routing engine in real-time.

## 🌟 Key Features
- **Dynamic Time-Travel Routing:** Simulate routes at different times of the day (e.g., 09:00 AM rush hour vs. Midnight). The engine dynamically adjusts edge weights based on historical traffic patterns.
- **Strict Time Window Constraints:** Define absolute deadlines for routes. The solver will reject mathematically impossible routes rather than providing false ETAs.
- **Service & Dwell Times:** Accounts for physical drop-off times (e.g., 15 minutes per stop) and cascades these delays sequentially through the route ETAs.
- **Macro-Routing (DBSCAN Clustering):** Groups thousands of unassigned orders into dense geographic clusters before sending them to the micro-solver, preventing API overload.
- **Step-by-Step UI Segmentation:** The frontend Leaflet.js map dynamically mathematically slices the continuous route geometry, allowing dispatchers to isolate and highlight specific turn-by-turn legs of the journey.

## 🛠️ Technology Stack
- **Machine Learning:** PyTorch, PyTorch Geometric (ST-GNN), Scikit-Learn (DBSCAN)
- **Routing & Optimization:** OSRM (Open Source Routing Machine), VROOM (Vehicle Routing Open-Source Optimization Machine)
- **Backend API:** FastAPI, Uvicorn, HTTPX
- **Database:** PostgreSQL, PostGIS (Spatial queries)
- **Frontend:** HTML5, TailwindCSS, Vanilla JS, Leaflet.js, Leaflet PolylineDecorator

## 🏗️ System Architecture

The project consists of three deeply integrated tiers:

1. **Macroscopic Traffic Prediction (ST-GNN)**
   - **Model:** PyTorch Spatio-Temporal Graph Neural Network (ST-GNN).
   - **Function:** Learns historical GPS trajectory patterns to predict future traffic speeds across 17,925 street segments in Colombo.
   - **Time-Travel Bridge:** A FastAPI microservice runs natively on the host machine to execute PyTorch inference on-demand, generating dynamic traffic snapshots based on user-selected timeframes.

2. **Microscopic Routing & Optimization (OSRM & VROOM)**
   - **OSRM:** Hosts the physical graph of Colombo. Uses the Multi-Level Dijkstra (MLD) algorithm to allow sub-second hot-reloading of the ST-GNN traffic predictions via `--segment-speed-file`.
   - **VROOM:** Solves the Traveling Salesperson Problem (TSP). It acts as a wrapper around OSRM, calculating constraints such as vehicle capacities, strict delivery deadlines, and dwell times.

3. **Backend API & Web Dashboard**
   - **FastAPI / PostGIS:** Handles fleet constraints, geo-spatial queries, and coordinates between the ML pipeline and VROOM solver.
   - **Interactive UI (Leaflet.js):** Allows dynamic pin-dropping, strict deadline definitions, and time-travel simulation.

## 📂 Project Structure
```text
route-optimizer/
├── api/
│   ├── main.py                # Core FastAPI backend
│   ├── requirements.txt
│   └── static/                # Web Dashboard UI
│       ├── index.html         
│       ├── app.js             # Leaflet rendering and route slicing
│       └── style.css          
├── ml-pipeline/
│   ├── data_simulator.py      # Physics-based synthetic trajectory generator
│   ├── map_matcher.py         # Snaps raw GPS to OSRM nodes via HMM
│   ├── train_stgnn.py         # PyTorch ST-GNN model definition and training loop
│   ├── update_osrm_traffic.py # Generates predictions and hot-reloads OSRM
│   └── ml_api.py              # Host-level FastAPI bridge for dynamic PyTorch inference
├── data/                      # PBF maps, OSRM binaries, and generated traffic.csv
├── docker-compose.yml         # Container orchestration (OSRM, VROOM, DB, API)
└── README.md
```

## 📊 Dataset & Simulation

Because highly granular open-source GPS data for Colombo is unavailable, we built a physics-engine based Data Simulator (`data_simulator.py`).

* **Trajectory Generation:** Generates 60,000+ synthetic GPS pings by generating physical routes between random dense clusters.
* **Traffic Penalties:** Injects deterministic speed penalties during peak hours.
* **Map-Matching:** Uses Hidden Markov Models (via OSRM `/match`) to aggressively snap noisy GPS pings to their true OpenStreetMap nodes, building the fundamental graph structure.

### Training with Real-World Data
If you have access to real fleet telemetry (e.g., from an Uber, Lyft, or local ride-hailing dataset), you can entirely bypass the simulator.
1. Extract your raw GPS pings into chronological trip chunks.
2. Feed the raw coordinates `[lon, lat]` into the OSRM `/match` endpoint (see `map_matcher.py` for the batching logic).
3. OSRM will return the true physical `osm_node_id` path and exact traversal durations.
4. Export this directly to `data/real_traffic_edges.csv`. The model will natively ingest this file and train on your true historical speeds.

### Sample Data Format (`traffic.csv`)
The ML model outputs a CSV that OSRM natively ingests to update edge weights.
```csv
from_node_osm_id, to_node_osm_id, speed_kmh
123456789, 987654321, 24
123456790, 987654322, 12
```

## 🧠 ML Model Architecture & Accuracy

The traffic prediction engine is powered by a **Spatio-Temporal Graph Neural Network (ST-GNN)**. 

### Architecture Breakdown
The network is designed to capture both the *spatial* relationships (traffic spilling over from adjacent streets) and *temporal* relationships (historical buildup over previous hours).
1. **Temporal Gating 1:** `nn.GRU` (Input: 1, Hidden: 64) processes the raw 12-hour historical speed sequences per node.
2. **Spatial Convolutions:** Two consecutive `GCNConv` (Graph Convolutional Network) layers propagate traffic states across the 17,925 physical nodes using the true OpenStreetMap edge topology.
3. **Temporal Gating 2:** A second `nn.GRU` acts on the spatially-aware embeddings to predict the future state.
4. **Readout:** Fully connected `Linear` layers project the 64-dim embeddings down to a single future speed prediction.

* **Total Trainable Parameters:** ~47,500
* **Input Window:** Last 12 hours (`seq_len = 12`)
* **Output Window:** Next 1 hour (`future_steps = 1`)
* **Current Accuracy:** On the synthetic 60k ping dataset, the model converged to an MSE loss of ~0.08 (normalized speed variances), proving it can successfully memorize peak/off-peak sinusoidal patterns when data is dense enough.

### 🔮 Future ML Improvements
* **Attention Mechanisms:** Upgrading the `GCNConv` layers to `GATConv` (Graph Attention Networks) so the model can learn that highways impact adjacent nodes more than small residential alleys.
* **Exogenous Features:** Adding weather data (rain drastically reduces speeds in Colombo), day-of-week embeddings (weekends vs weekdays), and local holidays to the input features.
* **Deeper Temporal Windows:** Expanding the GRU to look at the same hour from the *previous day* rather than just the last 12 contiguous hours.

## 🗺️ Google Maps API Integration

While this project is built entirely on open-source tools (OSRM, Leaflet) to avoid vendor lock-in and high API costs, you can easily swap in Google Maps APIs for commercial enterprise use:

### 1. Using Google Maps for the UI
To replace the open-source Leaflet.js map with Google Maps:
1. Obtain a **Google Maps JavaScript API Key** from the Google Cloud Console.
2. In `api/static/index.html`, replace the Leaflet script with the Google Maps loader: `<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=geometry"></script>`
3. In `app.js`, replace the Leaflet map initialization (`L.map`) with `new google.maps.Map(document.getElementById("map"))`.
4. Use `google.maps.Polyline` instead of `L.polyline` to render the VROOM geometry.

### 2. Harvesting True Traffic Data for ML Training
If you do not have your own fleet telemetry, you can use the **Google Routes API** to build a highly accurate historical dataset to train the ST-GNN:
1. **Define a Grid:** Create a list of the 1,000 most important intersections in your city.
2. **Ping the API:** Write a Python cron job that pings the Google Routes API (`computeRoutes`) every hour for routes between adjacent intersections.
3. **Extract Traffic:** Ensure you set `routingPreference: TRAFFIC_AWARE` and extract the `duration` vs `staticDuration`.
4. **Format for Training:** Calculate the speed (`distance / duration`) and format it into the `real_traffic_edges.csv` format: `from_node, to_node, hour, speed_kmh`.
5. **Cost Warning:** The Google Routes API charges per request. Pinging 5,000 edges every hour will rapidly consume your API quota, so it is recommended to only harvest data for major arterial roads for a few weeks to train the model, rather than running it indefinitely.

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

## 🔌 Core API Endpoints

- `POST /api/v1/cluster-orders`: Accepts an array of lat/lon coordinates and groups them using DBSCAN.
- `POST /api/v1/optimize-route`: Coordinates the ML Time-Travel bridge, triggers VROOM, and calculates sequence and polylines.
- `POST /api/v1/telemetry`: High-throughput ingestion endpoint for live driver GPS pings.

## ⚠️ Limitations & Gaps to Improve

1. **Data Sparsity (The Zero-Tensor Problem):** The ST-GNN requires historical data for every single street segment at every single hour. Because the simulated dataset only generated 60,000 points across 17,900 edges, the 3D tensor (`[nodes, 24, 1]`) was 95% empty. To compensate for unobserved edges predicting global averages, we temporarily apply synthetic deterministic multipliers. **Fix:** Train on an extremely dense, real-world dataset (e.g. Uber Movement data or local ride-hailing datasets).
2. **Sequential Time Window Routing:** VROOM optimizes the entire route based on the traffic snapshot of the *start time*. If a 50-stop route takes 6 hours to complete, the later stops are still routed using the morning traffic graph. **Fix:** Implement true Time-Dependent Routing (TDR) natively within a customized OSRM engine.
3. **Dockerizing the ML Pipeline:** The ML pipeline currently relies on a host-level bridge API to access GPU acceleration. **Fix:** Build a dedicated `pytorch` Docker container to house the ST-GNN, communicating internally via Docker networks.
