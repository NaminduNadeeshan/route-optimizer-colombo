from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
from sklearn.cluster import DBSCAN
import httpx
import asyncpg
import os

app = FastAPI(title="Motorcycle Route Optimizer API (Sri Lanka)")

# --- Database Config ---
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASS = os.getenv("DB_PASS", "postgres")
DB_HOST = os.getenv("DB_HOST", "route_db")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "routing_db")

VROOM_URL = os.getenv("VROOM_URL", "http://route_vroom:3000")

# --- Pydantic Models ---
class Coordinate(BaseModel):
    id: int
    lat: float
    lon: float

class ClusterRequest(BaseModel):
    orders: List[Coordinate]
    max_distance_km: float = 2.0  # Max distance between points in a cluster

class TelemetryPing(BaseModel):
    rider_id: int
    lat: float
    lon: float
    speed_kmh: float

class OptimizeRouteRequest(BaseModel):
    rider_id: int
    depot_location: List[float] # [lon, lat]
    order_ids: List[int]
    max_duration_seconds: Optional[int] = 86400  # Default 24 hours
    start_hour: Optional[int] = 9

# --- Connection Pool ---
db_pool = None

@app.on_event("startup")
async def startup():
    global db_pool
    db_pool = await asyncpg.create_pool(
        user=DB_USER, password=DB_PASS, database=DB_NAME, host=DB_HOST, port=DB_PORT
    )

@app.on_event("shutdown")
async def shutdown():
    await db_pool.close()

# --- Endpoints ---

@app.post("/api/v1/cluster-orders")
async def cluster_orders(payload: ClusterRequest):
    """
    Tier 1: Macro-Routing. Group hundreds of orders into geographic clusters
    using DBSCAN and Haversine distances to avoid overloading VROOM.
    """
    if not payload.orders:
        raise HTTPException(status_code=400, detail="No orders provided")

    # Extract coordinates into a numpy array (lat, lon) in radians for Haversine
    coords = np.array([[order.lat, order.lon] for order in payload.orders])
    coords_radians = np.radians(coords)
    
    # Earth radius in KM
    EARTH_RADIUS_KM = 6371.0
    epsilon = payload.max_distance_km / EARTH_RADIUS_KM
    
    # Run DBSCAN
    # min_samples=1 so isolated points just form their own cluster
    db = DBSCAN(eps=epsilon, min_samples=1, algorithm='ball_tree', metric='haversine').fit(coords_radians)
    labels = db.labels_
    
    clusters = {}
    for order, label in zip(payload.orders, labels):
        cluster_id = int(label)
        if cluster_id not in clusters:
            clusters[cluster_id] = []
        clusters[cluster_id].append(order.id)
        
    return {"clusters": clusters}


@app.post("/api/v1/optimize-route")
async def optimize_route(payload: OptimizeRouteRequest):
    """
    Tier 2: Micro-Routing. Take a clustered batch of orders, query DB for their coordinates, 
    send to VROOM, return turn-by-turn sequence, and mark as assigned.
    """
    if not payload.order_ids:
        raise HTTPException(status_code=400, detail="No order IDs provided")

    # 0. Time-Travel Routing Bridge
    # Trigger the PyTorch ML pipeline running natively on the Mac Host
    try:
        async with httpx.AsyncClient() as client:
            print(f"Requesting ML Traffic generation for {payload.start_hour}:00...")
            await client.post(
                f"http://host.docker.internal:8001/update-traffic/{payload.start_hour}", 
                timeout=30.0
            )
    except httpx.RequestError as e:
        print(f"Warning: ML Bridge API not reachable. Using static OSRM traffic. ({e})")
    except httpx.HTTPStatusError as e:
        print(f"Warning: ML Bridge API failed. {e.response.text}")

    # 1. Fetch order coordinates and weights from PostGIS
    query = """
        SELECT id, ST_X(dropoff_location::geometry) as lon, ST_Y(dropoff_location::geometry) as lat, weight 
        FROM orders 
        WHERE id = ANY($1::int[])
    """
    async with db_pool.acquire() as connection:
        records = await connection.fetch(query, payload.order_ids)
    
    if not records:
        raise HTTPException(status_code=404, detail="None of the specified orders were found in the database")

    # 2. Construct VROOM payload
    vroom_payload = {
        "vehicles": [
            {
                "id": payload.rider_id,
                "profile": "car", # Mapped to motorcycle profile in OSRM
                "start": payload.depot_location,
                "end": payload.depot_location,
                "capacity": [100], # Must provide capacity if jobs have delivery amounts
                "time_window": [0, payload.max_duration_seconds]
            }
        ],
        "jobs": [
            {
                "id": record["id"],
                "location": [record["lon"], record["lat"]],
                "delivery": [int(record["weight"])] if record["weight"] else [],
                "service": 900  # 15 minutes in seconds
            } for record in records
        ],
        "options": {
            "g": True  # Request geometry to force VROOM to calculate exact distances
        }
    }

    # 3. Make async HTTP request to local VROOM solver
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(VROOM_URL, json=vroom_payload, timeout=60.0)
            response.raise_for_status()
            vroom_data = response.json()
        except httpx.HTTPStatusError as e:
            error_details = e.response.text
            raise HTTPException(status_code=500, detail=f"VROOM optimization failed: {error_details}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Optimization failed: {str(e)}")

    # 4. Parse the VROOM response
    summary = vroom_data.get("summary", {})
    route = vroom_data["routes"][0] if vroom_data.get("routes") else {"steps": []}
    steps = [
        {
            "type": step["type"], 
            "location": step.get("location"), 
            "job": step.get("job"), 
            "arrival": step.get("arrival", 0),
            "distance": step.get("distance", 0),
            "service": step.get("service", 0)
        } 
        for step in route.get("steps", [])
    ]

    # 5. Update orders status to 'assigned'
    update_query = """
        UPDATE orders SET status = 'assigned', assigned_rider_id = $1 
        WHERE id = ANY($2::int[])
    """
    async with db_pool.acquire() as connection:
        await connection.execute(update_query, payload.rider_id, payload.order_ids)

    return {
        "rider_id": payload.rider_id,
        "total_duration_seconds": summary.get("duration", 0),
        "total_distance_meters": summary.get("distance", summary.get("cost", 0)),
        "route_sequence": steps,
        "geometry": route.get("geometry")
    }


@app.post("/api/v1/telemetry")
async def ingest_telemetry(ping: TelemetryPing):
    """
    High-throughput endpoint to ingest live GPS pings from the rider app.
    Inserts into the PostGIS telemetry_logs table.
    """
    query = """
        INSERT INTO telemetry_logs (rider_id, location, speed_kmh)
        VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4)
    """
    try:
        async with db_pool.acquire() as connection:
            await connection.execute(
                query, 
                ping.rider_id, 
                ping.lon, # Note: PostGIS MakePoint is (Longitude, Latitude)
                ping.lat, 
                ping.speed_kmh
            )
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database insert failed: {str(e)}")

class CreateOrdersRequest(BaseModel):
    locations: List[List[float]] # List of [lon, lat]
    weight: int = 1

@app.post("/api/v1/create-orders")
async def create_orders(payload: CreateOrdersRequest):
    """
    Creates multiple orders in the DB from coordinates and returns their IDs.
    Used by the UI to dynamically drop pins.
    """
    if not payload.locations:
        raise HTTPException(status_code=400, detail="No locations provided")
        
    query = """
        INSERT INTO orders (customer_name, dropoff_location, weight, status)
        VALUES ('Web UI Customer', ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, 'pending')
        RETURNING id
    """
    order_ids = []
    try:
        async with db_pool.acquire() as connection:
            async with connection.transaction():
                for loc in payload.locations:
                    row = await connection.fetchrow(query, loc[0], loc[1], payload.weight)
                    order_ids.append(row["id"])
        return {"order_ids": order_ids}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database insert failed: {str(e)}")

# Mount static UI at the very end so it doesn't override API routes
from fastapi.staticfiles import StaticFiles
app.mount("/", StaticFiles(directory="static", html=True), name="static")
