'use strict';

// UI Elements
const loginPage = document.querySelector('#login-page');
const roomPage = document.querySelector('#room-page');
const callPage = document.querySelector('#call-page');
const connectBtn = document.querySelector('#connect-btn');
const joinBtn = document.querySelector('#join-btn');
const createBtn = document.querySelector('#create-btn');
const usernameInput = document.querySelector('#username');
const roomIdInput = document.querySelector('#room-id');
const localVideo = document.querySelector('#local-video');
const videosContainer = document.querySelector('#videos');
const usernameDisplay = document.querySelector('#username-display');
const roomIdDisplay = document.querySelector('#room-id-display');

// App state
let stompClient = null;
let username = null;
let roomId = null;
let localStream = null;
const peerConnections = {}; // Key: remoteUsername, Value: RTCPeerConnection

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Event Listeners
connectBtn.addEventListener('click', connect);
createBtn.addEventListener('click', () => joinRoom(true));
joinBtn.addEventListener('click', () => joinRoom(false));
hangupBtn.addEventListener('click', hangUp);

/**
 * Handles hanging up the call.
 */
function hangUp() {
    // Notify the server that the user is leaving
    const leaveMessage = {
        sender: username,
        type: 'leave',
        roomId: roomId
    };
    stompClient.send('/app/signal.leaveRoom', {}, JSON.stringify(leaveMessage));


    // Close all peer connections
    for (const remoteUsername in peerConnections) {
        if (peerConnections[remoteUsername]) {
            peerConnections[remoteUsername].close();
        }
    }

    // Stop local media stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Clean up UI
    const remoteVideos = document.querySelectorAll('.video-container:not(:first-child)');
    remoteVideos.forEach(video => video.remove());


    // Reset UI to room selection
    callPage.classList.add('hidden');
    roomPage.classList.remove('hidden');
    
    // Clear state
    roomId = null;
    for (const key in peerConnections) {
        delete peerConnections[key];
    }
}


/**
 * Connects to the WebSocket server and sets up the user.
 */
async function connect(event) {
    event.preventDefault();
    username = usernameInput.value.trim();
    if (!username) {
        alert('Please enter a username.');
        return;
    }

    // Start local video stream
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
    } catch (error) {
        console.error('Error accessing media devices.', error);
        alert('Could not access camera and microphone.');
        // Revert UI
        return;
    }

    // Establish WebSocket connection
    const socket = new SockJS('/ws');
    stompClient = Stomp.over(socket);

    // Pass the username in the headers.
    const headers = {
      'user-name': username
    };

    stompClient.connect(headers, onConnected, onError);
}

/**
 * Handles successful WebSocket connection.
 */
function onConnected() {
    console.log('Connected to WebSocket');
    // UI transitions
    loginPage.classList.add('hidden');
    roomPage.classList.remove('hidden');
    usernameDisplay.textContent = username;
}

/**
 * Handles WebSocket connection errors.
 */
function onError(error) {
    console.error('Could not connect to WebSocket server. Please refresh and try again!', error);
    alert('Connection error. See console for details.');

    // Reset UI
    loginPage.classList.remove('hidden');
    roomPage.classList.add('hidden');
    callPage.classList.add('hidden');
}

/**
 * Joins a room, either by creating a new one or joining an existing one.
 */
function joinRoom(isCreating) {
    roomId = isCreating ? generateRoomId() : roomIdInput.value.trim();
    if (!roomId) {
        alert('Please enter a Room ID.');
        return;
    }

    roomIdInput.value = roomId;
    roomPage.classList.add('hidden');
    callPage.classList.remove('hidden');
    roomIdDisplay.textContent = roomId;

    // Subscribe to the room topic
    stompClient.subscribe(`/topic/rooms/${roomId}`, onMessageReceived);

    // Send join message to the server
    const joinMessage = {
        sender: username,
        type: 'join',
        roomId: roomId
    };
    stompClient.send('/app/signal.joinRoom', {}, JSON.stringify(joinMessage));
}

/**
 * Main message handler for incoming signaling messages.
 */
function onMessageReceived(payload) {
    const message = JSON.parse(payload.body);
    console.log('Received message:', message);

    if (message.sender === username) {
        return;
    }

    switch (message.type) {
        case 'existing_users':
            // This user is the newcomer. Create offers for all existing users.
            const existingUsers = message.data;
            existingUsers.forEach(remoteUsername => {
                createPeerConnectionAndOffer(remoteUsername);
            });
            break;
        case 'new_user':
            // An existing user receives this when a new user joins.
            // The newcomer will send an offer, so we just wait.
            console.log(`New user joined: ${message.sender}`);
            break;
        case 'offer':
            // Received an offer from a peer, create an answer.
            handleOffer(message.sender, message.data);
            break;
        case 'answer':
            // Received an answer from a peer.
            handleAnswer(message.sender, message.data);
            break;
        case 'ice_candidate':
            // Received an ICE candidate from a peer.
            handleIceCandidate(message.sender, message.data);
            break;
        case 'user_left':
            // A user has left the room.
            handleUserLeft(message.sender);
            break;
        default:
            console.warn('Unknown message type:', message.type);
    }
}

/**
 * Creates a peer connection for a remote user and sends an offer.
 */
function createPeerConnectionAndOffer(remoteUsername) {
    const pc = createPeerConnection(remoteUsername);
    peerConnections[remoteUsername] = pc;

    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            sendSignalingMessage('offer', pc.localDescription);
        })
        .catch(e => console.error(`Error creating offer for ${remoteUsername}:`, e));
}

/**
 * Handles an incoming offer from a remote peer.
 */
function handleOffer(remoteUsername, sdp) {
    const pc = createPeerConnection(remoteUsername);
    peerConnections[remoteUsername] = pc;

    pc.setRemoteDescription(new RTCSessionDescription(sdp))
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
            sendSignalingMessage('answer', pc.localDescription);
        })
        .catch(e => console.error(`Error handling offer from ${remoteUsername}:`, e));
}

/**
 * Handles an incoming answer from a remote peer.
 */
function handleAnswer(remoteUsername, sdp) {
    const pc = peerConnections[remoteUsername];
    if (pc) {
        pc.setRemoteDescription(new RTCSessionDescription(sdp))
            .catch(e => console.error(`Error setting remote description for ${remoteUsername}:`, e));
    }
}

/**
 * Handles an incoming ICE candidate from a remote peer.
 */
function handleIceCandidate(remoteUsername, candidate) {
    const pc = peerConnections[remoteUsername];
    if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(e => console.error(`Error adding ICE candidate for ${remoteUsername}:`, e));
    }
}

/**
 * Cleans up when a user leaves the room.
 */
function handleUserLeft(remoteUsername) {
    console.log(`User ${remoteUsername} left the room.`);
    const pc = peerConnections[remoteUsername];
    if (pc) {
        pc.close();
        delete peerConnections[remoteUsername];
    }
    const videoElement = document.getElementById(`video-${remoteUsername}`);
    if (videoElement) {
        videoElement.parentElement.remove();
    }
}

/**
 * Helper to create and configure a new RTCPeerConnection.
 */
function createPeerConnection(remoteUsername) {
    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = event => {
        if (event.candidate) {
            sendSignalingMessage(remoteUsername, 'ice_candidate', event.candidate);
        }
    };

    pc.ontrack = event => {
        let videoContainer = document.getElementById(`container-${remoteUsername}`);
        if (!videoContainer) {
            videoContainer = document.createElement('div');
            videoContainer.id = `container-${remoteUsername}`;
            videoContainer.className = 'video-container';
            const h3 = document.createElement('h3');
            h3.textContent = remoteUsername;
            const remoteVideo = document.createElement('video');
            remoteVideo.id = `video-${remoteUsername}`;
            remoteVideo.autoplay = true;
            remoteVideo.playsinline = true;
            videoContainer.append(h3, remoteVideo);
            videosContainer.appendChild(videoContainer);
        }
        document.getElementById(`video-${remoteUsername}`).srcObject = event.streams[0];
    };

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    return pc;
}

/**
 * Helper to send a signaling message via WebSocket.
 */
function sendSignalingMessage(type, data) {
      const message = { 
        sender: username, 
        type, 
        data, 
        roomId 
  };
  stompClient.send('/app/signal.forward', {}, JSON.stringify(message));
}
/**
 * Generates a simple unique room ID.
 */
function generateRoomId() {
    return Math.random().toString(36).substring(2, 9);
}