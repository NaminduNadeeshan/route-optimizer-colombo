import kagglehub

print("Downloading Porto Taxi Dataset using kagglehub...")
path = kagglehub.dataset_download("crailtap/taxi-trajectory")
print("Path to dataset files:", path)
