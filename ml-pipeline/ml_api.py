from fastapi import FastAPI, HTTPException
import subprocess
import os
from typing import Optional

app = FastAPI(title="ML Traffic Bridge API")

@app.post("/update-traffic/{city}/{hour}")
def update_traffic(city: str, hour: int, date: Optional[str] = None):
    """
    Triggers the PyTorch ST-GNN inference script for the requested hour and city.
    This runs on the Host Mac (where Apple Silicon GPUs are accessible)
    and hot-reloads the corresponding OSRM Docker container.
    """
    print(f"Triggering PyTorch ML Pipeline for {city} at {hour}:00, Date: {date}...")
    try:
        script_path = os.path.join(os.path.dirname(__file__), "update_osrm_traffic.py")
        cmd = ["python3", script_path, "--hour", str(hour), "--city", city]
        if date:
            cmd.extend(["--date", date])
        subprocess.run(cmd, check=True)
        return {"status": "success", "hour": hour, "date": date}
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"ML Script failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
