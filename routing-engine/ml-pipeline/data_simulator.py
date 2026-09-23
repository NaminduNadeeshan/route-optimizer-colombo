import psycopg2
from psycopg2.extras import execute_values
import json
import urllib.request
import urllib.parse
import random
import math
from datetime import datetime, timedelta

# Database Connection
DB_CONFIG = {
    "dbname": "routing_db",
    "user": "postgres",
    "password": "postgres",
    "host": "127.0.0.1",
    "port": "5433"
}

OSRM_BASE = "http://localhost:5005"

# Bounding box for Greater Colombo
MIN_LAT = 6.8200
MAX_LAT = 6.9800
MIN_LON = 79.8400
MAX_LON = 79.9800

def get_random_snapped_point():
    """Generates a random point in the bounding box and snaps it to the road network."""
    while True:
        lat = random.uniform(MIN_LAT, MAX_LAT)
        lon = random.uniform(MIN_LON, MAX_LON)
        url = f"{OSRM_BASE}/nearest/v1/driving/{lon},{lat}?number=1"
        try:
            with urllib.request.urlopen(url) as response:
                data = json.loads(response.read().decode())
                if data["code"] == "Ok" and len(data["waypoints"]) > 0:
                    # OSRM returns [lon, lat]
                    return data["waypoints"][0]["location"]
        except Exception as e:
            print(f"Error calling OSRM nearest: {e}")
            pass

def fetch_route(start, end):
    """Fetches the full street polyline between two snapped points."""
    slon, slat = start
    elon, elat = end
    url = f"{OSRM_BASE}/route/v1/driving/{slon},{slat};{elon},{elat}?overview=full&geometries=geojson"
    try:
        with urllib.request.urlopen(url) as response:
            data = json.loads(response.read().decode())
            if data["code"] == "Ok" and len(data["routes"]) > 0:
                return data["routes"][0]["geometry"]["coordinates"]
    except Exception as e:
        print(f"Error calling OSRM route: {e}")
    return None

def haversine(lon1, lat1, lon2, lat2):
    """Calculates the distance in meters between two points."""
    R = 6371000 # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def simulate_trip(route_coords, rider_id, start_time):
    """Discretizes a route into telemetry pings."""
    pings = []
    current_time = start_time
    
    # 3 meters in degrees for GPS noise (approximate)
    noise_std = 3.0 / 111111.0 
    
    for i in range(len(route_coords) - 1):
        lon1, lat1 = route_coords[i]
        lon2, lat2 = route_coords[i+1]
        
        segment_dist = haversine(lon1, lat1, lon2, lat2)
        if segment_dist == 0:
            continue
            
        # Time-of-day speed modulation
        hour = current_time.hour
        if (7 <= hour <= 9) or (16 <= hour <= 18):
            # Peak hours: heavy congestion, 40-50% speed reduction (10-25 km/h)
            target_speed_kmh = random.uniform(10.0, 25.0)
        else:
            # Off-peak hours: normal street speeds (20-45 km/h)
            target_speed_kmh = random.uniform(20.0, 45.0)
            
        target_speed_ms = target_speed_kmh / 3.6
        
        # Calculate time taken for this segment
        segment_duration = segment_dist / target_speed_ms
        
        # Discretize segment into 10-15 second pings
        ping_interval = random.uniform(10, 15)
        
        elapsed = 0
        while elapsed < segment_duration:
            ratio = elapsed / segment_duration
            
            # Interpolate position
            curr_lon = lon1 + (lon2 - lon1) * ratio
            curr_lat = lat1 + (lat2 - lat1) * ratio
            
            # Add Gaussian noise
            noisy_lon = curr_lon + random.gauss(0, noise_std)
            noisy_lat = curr_lat + random.gauss(0, noise_std)
            
            pings.append((
                rider_id, 
                noisy_lon, 
                noisy_lat, 
                round(target_speed_kmh, 2), 
                current_time
            ))
            
            elapsed += ping_interval
            current_time += timedelta(seconds=ping_interval)
            
    return pings

def generate_city_wide_data(num_trips=200):
    all_pings = []
    
    # Start simulation 2 days ago
    sim_time = datetime.now() - timedelta(days=2)
    
    print(f"Generating {num_trips} simulated trips across Greater Colombo...")
    for i in range(num_trips):
        start = get_random_snapped_point()
        end = get_random_snapped_point()
        
        route = fetch_route(start, end)
        if route and len(route) > 1:
            rider_id = random.randint(1, 100) # Random rider
            pings = simulate_trip(route, rider_id, sim_time)
            all_pings.extend(pings)
            
            # Advance time randomly between trips
            sim_time += timedelta(minutes=random.randint(10, 60))
            
        if (i+1) % 10 == 0:
            print(f"  Processed {i+1}/{num_trips} trips... (Accumulated {len(all_pings)} pings)")
            
    return all_pings

def ingest_to_postgis(pings):
    if not pings:
        print("No pings generated to ingest.")
        return
        
    print(f"\nConnecting to database to ingest {len(pings)} telemetry pings...")
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()
    
    # Using high-performance execute_values
    insert_query = """
        INSERT INTO telemetry_logs (rider_id, location, speed_kmh, timestamp)
        VALUES %s
    """
    
    # Format template for execute_values
    template = "(%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s)"
    
    try:
        execute_values(cursor, insert_query, pings, template=template, page_size=10000)
        conn.commit()
        print(f"Successfully batch-ingested {len(pings)} simulated GPS points into PostGIS!")
    except Exception as e:
        conn.rollback()
        print(f"Error during insertion: {e}")
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    print("Starting Refactored City-Wide Data Simulation...")
    pings = generate_city_wide_data(num_trips=150)
    ingest_to_postgis(pings)
