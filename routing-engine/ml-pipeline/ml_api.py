from fastapi import FastAPI, HTTPException
import subprocess
import os

app = FastAPI(title="ML Traffic Bridge API")

@app.post("/update-traffic/{hour}")
def update_traffic(hour: int):
    """
    Triggers the PyTorch ST-GNN inference script for the requested hour.
    This runs on the Host Mac (where Apple Silicon GPUs are accessible)
    and hot-reloads the OSRM Docker container.
    """
    print(f"Triggering PyTorch ML Pipeline for {hour}:00...")
    try:
        script_path = os.path.join(os.path.dirname(__file__), "update_osrm_traffic.py")
        # Run the script using the current environment's Python (which has PyTorch)
        subprocess.run(["python3", script_path, "--hour", str(hour)], check=True)
        return {"status": "success", "hour": hour}
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ML Script failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
