const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Parse JSON request bodies
app.use(bodyParser.json());

// Store connected clients
let connectedPis = {};

// The URL of your Raspberry Pi, stored as an environment variable
const getRaspberryPiUrl = (clientId) => {
  if (clientId && connectedPis[clientId]) {
    return connectedPis[clientId].url;
  }
  return process.env.DEFAULT_RASPBERRY_PI_URL || 'http://localhost:5000';
};

// Simple API authentication middleware
const authenticateApi = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    connectedClients: Object.keys(connectedPis).length
  });
});

// Register a Raspberry Pi with the server
app.post('/api/register', authenticateApi, (req, res) => {
  const { clientId, url, name } = req.body;
  
  if (!clientId || !url) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  connectedPis[clientId] = {
    url,
    name: name || 'Unnamed Pi',
    lastSeen: new Date()
  };
  
  console.log(`Registered client: ${clientId}, ${url}`);
  
  return res.status(200).json({ 
    success: true,
    message: `Registered client: ${clientId}`
  });
});

// API endpoint that forwards requests to the Raspberry Pi
app.post('/api/alexa', authenticateApi, async (req, res) => {
  try {
    console.log('Received API request:', req.body);
    
    // Get the client ID from the request or use default
    const clientId = req.headers['x-client-id'] || 'default';
    const raspberryPiUrl = getRaspberryPiUrl(clientId);
    
    // Forward the request to the Raspberry Pi
    const response = await axios.post(`${raspberryPiUrl}/api/alexa`, req.body, {
      timeout: 5000 // 5 second timeout
    });
    
    console.log('Response from Raspberry Pi:', response.data);
    
    // Update the last seen timestamp
    if (connectedPis[clientId]) {
      connectedPis[clientId].lastSeen = new Date();
    }
    
    // Return the response from the Raspberry Pi
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Error forwarding request to Raspberry Pi:', error.message);
    
    // Return an error response
    return res.status(500).json({
      error: 'Failed to communicate with the surveillance system',
      details: error.message
    });
  }
});

// DIRECT ALEXA SKILL ENDPOINT
app.post('/alexa', async (req, res) => {
  try {
    console.log('Received Alexa request:', JSON.stringify(req.body));
    
    // Get request type
    const requestType = req.body.request.type;
    
    // Handle different request types
    if (requestType === 'LaunchRequest') {
      return res.json({
        version: '1.0',
        response: {
          outputSpeech: {
            type: 'PlainText',
            text: 'Welcome to Surveillance Camera. You can say things like, display camera 1, or hide all cameras.'
          },
          reprompt: {
            outputSpeech: {
              type: 'PlainText',
              text: 'You can say things like, display camera 1, or hide all cameras.'
            }
          },
          shouldEndSession: false
        }
      });
    } 
    else if (requestType === 'IntentRequest') {
      const intentName = req.body.request.intent.name;
      const slots = req.body.request.intent.slots || {};
      
      let speakOutput = '';
      let intentData = {
        intent: intentName,
        slots: {}
      };
      
      // Extract slot values
      if (intentName === 'OpenCameraIntent' || intentName === 'CloseCameraIntent') {
        if (slots.CameraNumber && slots.CameraNumber.value) {
          intentData.slots.CameraNumber = slots.CameraNumber.value;
        }
        if (slots.FirstCamera && slots.FirstCamera.value) {
          intentData.slots.FirstCamera = slots.FirstCamera.value;
        }
        if (slots.SecondCamera && slots.SecondCamera.value) {
          intentData.slots.SecondCamera = slots.SecondCamera.value;
        }
        if (slots.AllCameras && slots.AllCameras.value) {
          intentData.slots.AllCameras = slots.AllCameras.value;
        }
      }
      
      // Only forward to Raspberry Pi for camera-control intents
      if (['OpenCameraIntent', 'CloseCameraIntent', 'ShowAllCamerasIntent'].includes(intentName)) {
        // Get the client ID (default for now)
        const clientId = 'default';
        const raspberryPiUrl = getRaspberryPiUrl(clientId);
        
        // Forward to Raspberry Pi
        try {
          await axios.post(`${raspberryPiUrl}/api/alexa`, intentData, {
            timeout: 5000
          });
          
          // Generate response based on intent and slots
          if (intentName === 'OpenCameraIntent') {
            if (intentData.slots.CameraNumber) {
              speakOutput = `Displaying camera ${intentData.slots.CameraNumber}.`;
            } else if (intentData.slots.FirstCamera && intentData.slots.SecondCamera) {
              speakOutput = `Displaying cameras ${intentData.slots.FirstCamera} and ${intentData.slots.SecondCamera}.`;
            } else {
              speakOutput = 'Displaying all cameras.';
            }
          } else if (intentName === 'CloseCameraIntent') {
            if (intentData.slots.CameraNumber) {
              speakOutput = `Hiding camera ${intentData.slots.CameraNumber}.`;
            } else if (intentData.slots.FirstCamera && intentData.slots.SecondCamera) {
              speakOutput = `Hiding cameras ${intentData.slots.FirstCamera} and ${intentData.slots.SecondCamera}.`;
            } else {
              speakOutput = 'Hiding all cameras.';
            }
          } else if (intentName === 'ShowAllCamerasIntent') {
            speakOutput = 'Displaying all cameras.';
          }
        } catch (error) {
          console.error('Error forwarding to Raspberry Pi:', error.message);
          speakOutput = 'Sorry, there was a problem connecting to the surveillance system.';
        }
      } else if (intentName === 'AMAZON.HelpIntent') {
        speakOutput = 'You can say things like, display camera 1, display cameras 1 and 2, or hide all cameras. How can I help?';
      } else if (['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(intentName)) {
        speakOutput = 'Goodbye!';
        return res.json({
          version: '1.0',
          response: {
            outputSpeech: {
              type: 'PlainText',
              text: speakOutput
            },
            shouldEndSession: true
          }
        });
      }
      
      return res.json({
        version: '1.0',
        response: {
          outputSpeech: {
            type: 'PlainText',
            text: speakOutput
          },
          shouldEndSession: false
        }
      });
    }
    else if (requestType === 'SessionEndedRequest') {
      // Session ended, no response needed
      return res.json({
        version: '1.0',
        response: {}
      });
    }
    
    // Default response for unhandled request types
    return res.json({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: 'I\'m not sure how to help with that.'
        },
        shouldEndSession: false
      }
    });
    
  } catch (error) {
    console.error('Error handling Alexa request:', error);
    return res.json({
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: 'Sorry, there was a problem processing your request.'
        },
        shouldEndSession: false
      }
    });
  }
});

// Ping endpoint for the Raspberry Pi to keep the connection alive
app.post('/api/ping', authenticateApi, (req, res) => {
  const { clientId, url } = req.body;
  
  if (!clientId) {
    return res.status(400).json({ error: 'Missing client ID' });
  }
  
  // Create or update the client entry
  if (!connectedPis[clientId] && url) {
    connectedPis[clientId] = {
      url,
      name: req.body.name || 'Unnamed Pi',
      lastSeen: new Date()
    };
  } else if (connectedPis[clientId]) {
    connectedPis[clientId].lastSeen = new Date();
    if (url) {
      connectedPis[clientId].url = url;
    }
    if (req.body.name) {
      connectedPis[clientId].name = req.body.name;
    }
  }
  
  return res.status(200).json({ success: true });
});

// Client management - clean up stale clients
setInterval(() => {
  const now = new Date();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  Object.keys(connectedPis).forEach(clientId => {
    const client = connectedPis[clientId];
    if (now - client.lastSeen > staleThreshold) {
      console.log(`Removing stale client: ${clientId}`);
      delete connectedPis[clientId];
    }
  });
}, 60 * 1000); // Check every minute

// Start the server
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});