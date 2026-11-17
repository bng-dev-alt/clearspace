#!/bin/bash

# Change to the directory where this script is located
cd "$(dirname "$0")"

PORT=3000

echo "======================================"
echo "      ClearSpace Local Launcher"
echo "======================================"

# Check if port is already in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "Port $PORT is already in use."
    echo "Assuming ClearSpace (or another app) is already running."
    echo "Opening browser..."
    open "http://localhost:$PORT"
    
    echo ""
    echo "This launcher window will close in 5 seconds."
    echo "(To stop the server, find the original terminal window and press Ctrl+C)"
    sleep 5
    exit 0
fi

if [ ! -d "frontend" ]; then
    echo "Error: 'frontend' directory not found!"
    echo "Make sure this script is in the root of the project."
    sleep 5
    exit 1
fi

cd frontend

# Run a background process that waits for the port to open and then opens the browser
(
  while ! nc -z localhost $PORT >/dev/null 2>&1; do   
    sleep 1
  done
  echo "Server is ready! Opening browser at http://localhost:$PORT..."
  open "http://localhost:$PORT"
) &

echo "Starting Next.js development server on port $PORT..."
echo "To STOP the server, simply press Ctrl+C in this window or close this terminal window."
echo "======================================"

# Run the dev server in the foreground
npm run dev -- -p $PORT
