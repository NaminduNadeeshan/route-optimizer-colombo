import psycopg2
import pandas as pd
import requests
import os
from tqdm import tqdm
import math

DB_CONFIG = {
    "dbname": "routing_db",
    "user": "postgres",
    "password": "postgres",
    "host": "127.0.0.1",
    "port": "5433"
}

OSRM_MATCH_URL = "http://localhost:5005/match/v1/car/"

def fetch_all_telemetry():
    print("📥 Fetching telemetry logs from PostGIS...")
    conn = psycopg2.connect(**DB_CONFIG)
    query = """
        SELECT rider_id, ST_X(location::geometry) as lon, ST_Y(location::geometry) as lat, speed_kmh, timestamp
        FROM telemetry_logs
        ORDER BY rider_id, timestamp ASC
    """
    df = pd.read_sql_query(query, conn)
    conn.close()
    print(f"Loaded {len(df)} total pings.")
    return df

def extract_trips(df):
    """Groups pings into continuous trips by rider and time gaps."""
    print("✂️  Segmenting continuous trips...")
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    
    # Calculate time difference between consecutive rows
    df['time_diff'] = df.groupby('rider_id')['timestamp'].diff()
    
    # New trip if gap > 5 minutes
    df['new_trip'] = (df['time_diff'] > pd.Timedelta(minutes=5)).astype(int)
    
    # Assign a unique trip ID
    df['trip_id'] = df.groupby('rider_id')['new_trip'].cumsum()
    df['global_trip_id'] = df['rider_id'].astype(str) + "_" + df['trip_id'].astype(str)
    
    trips = [group for _, group in df.groupby('global_trip_id') if len(group) >= 5]
    print(f"Extracted {len(trips)} valid trips.")
    return trips

def process_map_matching(trips):
    """Sends trips to OSRM in chunks to find real OSM edges and calculate speeds."""
    all_segments = []
    
    print(f"🗺️  Map-Matching {len(trips)} trips against OSRM (this may take a minute)...")
    
    # For speed of demonstration, limit to a maximum of 500 trips
    if len(trips) > 500:
        trips = trips[:500]
        
    for trip_df in tqdm(trips):
        # Chunk the trip into blocks of 70 to avoid URI Too Long errors
        chunk_size = 70
        for i in range(0, len(trip_df), chunk_size):
            chunk = trip_df.iloc[i:i + chunk_size]
            if len(chunk) < 2:
                continue
                
            coords_string = ";".join([f"{row['lon']},{row['lat']}" for _, row in chunk.iterrows()])
            params = {"tidy": "true", "annotations": "nodes,distance,duration"}
            
            try:
                # Timestamps for interpolation
                chunk_times = chunk['timestamp'].tolist()
                
                res = requests.get(OSRM_MATCH_URL + coords_string, params=params)
                if res.status_code == 200:
                    data = res.json()
                    matchings = data.get("matchings", [])
                    
                    for match in matchings:
                        if match.get("confidence", 0) < 0.5:
                            continue
                            
                        legs = match.get("legs", [])
                        for leg_idx, leg in enumerate(legs):
                            annotations = leg.get("annotation", {})
                            nodes = annotations.get("nodes", [])
                            distances = annotations.get("distance", [])
                            durations = annotations.get("duration", [])
                            
                            # Determine the hour of the day for this leg
                            hour = chunk_times[leg_idx].hour
                            
                            for j in range(len(nodes) - 1):
                                if durations[j] > 0:
                                    calc_speed = (distances[j] / durations[j]) * 3.6
                                    all_segments.append({
                                        "source_node": nodes[j],
                                        "target_node": nodes[j+1],
                                        "speed_kmh": calc_speed,
                                        "hour": hour
                                    })
            except Exception as e:
                pass # Skip chunks that fail or timeout

    return pd.DataFrame(all_segments)

def aggregate_and_save(segments_df):
    if segments_df.empty:
        print("No segments matched.")
        return
        
    print("📊 Aggregating historical speeds by edge and hour...")
    
    # We want average speed for each specific edge at a specific hour
    aggregated = segments_df.groupby(['source_node', 'target_node', 'hour']).agg(
        avg_speed=('speed_kmh', 'mean'),
        samples=('speed_kmh', 'count')
    ).reset_index()
    
    # Filter out noisy single-sample data
    aggregated = aggregated[aggregated['samples'] > 1]
    
    # Save to CSV
    output_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "real_traffic_edges.csv")
    
    aggregated.to_csv(out_path, index=False)
    print(f"Saved {len(aggregated)} unique traffic edge profiles to {out_path}!")

if __name__ == "__main__":
    df = fetch_all_telemetry()
    trips = extract_trips(df)
    segments = process_map_matching(trips)
    aggregate_and_save(segments)
