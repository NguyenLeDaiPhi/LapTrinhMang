"use strict";

const usernamePage = document.querySelector("#username-page");
const chatPage = document.querySelector("#chat-page");
const usernameForm = document.querySelector("#usernameForm");
const yourUsernameSpan = document.querySelector("#your-username");
const userList = document.querySelector("#users");
const connectingElement = document.querySelector(".connecting");
const logoutButton = document.querySelector("#logout-button");
const audioContainer = document.querySelector("#audio-container");
const encryptCheckbox = document.querySelector("#encrypt-checkbox");
const encryptionStatus = document.querySelector("#encryption-status");
const refreshUsersBtn = document.querySelector("#refresh-users-btn");
const userCount = document.querySelector("#user-count");

// Call notification modal elements
const callNotificationModal = document.querySelector("#call-notification-modal");
const callerNameElement = document.querySelector("#caller-name");
const acceptCallBtn = document.querySelector("#accept-call-btn"); 
const rejectCallBtn = document.querySelector("#reject-call-btn");
const outgoingCallModal = document.querySelector("#outgoing-call-modal");
const outgoingCallTarget = document.querySelector("#outgoing-call-target");
const cancelCallBtn = document.querySelector("#cancel-call-btn");
const activeCallSection = document.querySelector("#active-call-section");
const activeCallName = document.querySelector("#active-call-name");
const activeCallStatus = document.querySelector("#active-call-status");
const endCallBtn = document.querySelector("#end-call-btn");

let stompClient = null;
let username = null;
let localStream;

// Storing peer connections: { 'otherUser': RTCPeerConnection }
const peerConnections = {};

// For E2EE - Store encryption keys per peer connection
let useEncryption = false;
const encryptionKeys = {}; // { 'otherUser': CryptoKey }

// Call state management
let incomingCallFrom = null; // Username of person calling us
let outgoingCallTo = null; // Username we are calling
let callTimeout = null;
let activeCallWith = null; // Username we are currently in a call with

const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

async function connect(event) {
  event.preventDefault();
  username = usernamePage.getAttribute("data-username");
  useEncryption = encryptCheckbox.checked;

  // Disable the form to prevent multiple connection attempts
  usernameForm.querySelector("button").setAttribute("disabled", "true");
  encryptCheckbox.setAttribute("disabled", "true");

  if (!username) return;

  usernamePage.classList.add("hidden");
  chatPage.classList.remove("hidden");
  yourUsernameSpan.textContent = username;
  connectingElement.classList.remove("hidden");
  
  // Update encryption status
  if (useEncryption) {
    encryptionStatus.textContent = "🔒 Encryption Enabled";
    encryptionStatus.className = "encryption-badge";
  } else {
    encryptionStatus.textContent = "🔓 Encryption Disabled";
    encryptionStatus.className = "encryption-badge";
  }

  try {
    // --- A more robust connection flow ---

    // 1. Get the local audio stream from the user
    const streamPromise = navigator.mediaDevices
      .getUserMedia({
        audio: true,
        video: false,
      })
      .then((stream) => {
        console.log("Microphone access granted.");
        localStream = stream;
        const localAudio = document.createElement("audio");
        localAudio.srcObject = localStream;
        localAudio.id = "local-audio";
        localAudio.muted = true;
        localAudio.play();
        audioContainer.appendChild(localAudio);
        return stream; // Pass the stream along
      });

    // 2. Establish the WebSocket connection
    const stompPromise = new Promise((resolve, reject) => {
      const getCookie = (name) => {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(";").shift();
      };
      const socket = new SockJS("/ws");
      stompClient = Stomp.over(socket);
      stompClient.connect(
        { Authorization: `Bearer ${getCookie("jwt-token-user")}` },
        () => {
          console.log("WebSocket connection established.");
          resolve(stompClient);
        },
        (error) => {
          console.error("STOMP connection error:", error);
          reject(error);
        }
      );
    });

    // 3. Wait for BOTH the stream and the connection to be ready
    await Promise.all([streamPromise, stompPromise]);

    console.log("Ready for signaling. Subscribing to topics...");
    connectingElement.classList.add("hidden");

    // 4. Now that we are fully ready, subscribe to topics
    console.log("Subscribing to /topic/public");
    const publicSubscription = stompClient.subscribe("/topic/public", onPublicMessageReceived);
    console.log("Public subscription:", publicSubscription);
    
    const privateQueue = `/user/${username}/queue/signals`;
    console.log(`Subscribing to ${privateQueue}`);
    const privateSubscription = stompClient.subscribe(
      privateQueue,
      (payload) => {
        console.log(`Received message on private queue ${privateQueue}:`, payload);
        onPrivateMessageReceived(payload);
      }
    );
    console.log("Private subscription:", privateSubscription);
    
    // Verify subscription after a short delay
    setTimeout(() => {
      console.log("Checking subscriptions...");
      console.log("Public subscription active:", publicSubscription ? true : false);
      console.log("Private subscription active:", privateSubscription ? true : false);
    }, 500);

    // 5. Announce our presence to others with encryption preference
    const joinMessage = { 
      sender: username, 
      type: "JOIN",
      useEncryption: useEncryption 
    };
    console.log("Sending JOIN message:", joinMessage);
    stompClient.send(
      "/app/signal.join",
      {},
      JSON.stringify(joinMessage)
    );
    
    // 6. Request list of users after a delay to ensure subscription is ready
    // Request multiple times to ensure we get the list
    setTimeout(() => {
      console.log("Requesting list of active users (first attempt)...");
      requestUsersList();
    }, 1500); // Wait 1.5 seconds for subscriptions to be ready
    
    // Second attempt after 3 seconds as backup
    setTimeout(() => {
      console.log("Requesting list of active users (backup attempt)...");
      requestUsersList();
    }, 3000);
  } catch (error) {
    console.error("Failed to connect or get media:", error);
    alert("Could not connect. Please check permissions and refresh the page.");
    connectingElement.textContent = "Failed to connect";
  }
}

function onPublicMessageReceived(payload) {
  try {
    const message = JSON.parse(payload.body);
    console.log("Public message received:", message);
    
    if (message.type === "JOIN" && message.sender !== username) {
      console.log(`New user joined (public): ${message.sender}`);
      addUserToList(message.sender);
      
      // Don't create peer connection automatically - wait for user to click Call
      // This prevents unwanted connections when users just join
      console.log(`User ${message.sender} added to list. Click "Call" button to start connection.`);
    } else if (message.type === "USER_LIST") {
      // This is a message sent to a specific user via public topic
      // Filter by recipient to only process messages meant for us
      if (message.recipient === username && message.sender !== username) {
        console.log(`Received USER_LIST message for me with user: ${message.sender}`);
        addUserToList(message.sender);
        
        // Don't create peer connection automatically - wait for user to click Call
        // This prevents unwanted connections when users just join
      }
    } else if (message.type === "OFFER" || message.type === "ANSWER" || message.type === "ICE") {
      // Handle signaling messages that might come via public topic (fallback)
      // Only process if recipient is us
      if (message.recipient === username && message.sender !== username) {
        console.log(`Received ${message.type} via public topic from ${message.sender} (fallback mechanism)`);
        // Process as if it came from private queue
        // Note: This might be a duplicate if also received via private queue, but processing is idempotent
        onPrivateMessageReceived(payload);
      }
    } else if (message.type === "CALL_REQUEST" || message.type === "CALL_ACCEPTED" || 
               message.type === "CALL_REJECTED" || message.type === "CALL_ENDED") {
      // Handle call-related messages via public topic (fallback)
      if (message.recipient === username && message.sender !== username) {
        console.log(`Received ${message.type} via public topic from ${message.sender}`);
        onPrivateMessageReceived(payload);
      }
    } else if (message.type === "LEAVE" && message.sender !== username) {
      console.log(`User left: ${message.sender}`);
      removeUser(message.sender);
    }
  } catch (error) {
    console.error("Error processing public message:", error);
  }
}

async function onPrivateMessageReceived(payload) {
  try {
    const signal = JSON.parse(payload.body);
    const sender = signal.sender;

    console.log(`Private signal received from ${sender}`, signal);
    console.log(`Signal type: ${signal.type}`);

    let pc = peerConnections[sender];
    if (pc === undefined && signal.type === "OFFER") {
      // If we are the receiver of the offer, create a peer connection.
      console.log(`Receiving OFFER from ${sender}, creating new peer connection...`);
      createPeerConnection(sender, false);
      pc = peerConnections[sender];
    }

    if (signal.type === "OFFER") {
      if (!pc) {
        console.error(`No peer connection for ${sender} when receiving OFFER`);
        // Try to create one
        createPeerConnection(sender, false);
        pc = peerConnections[sender];
        if (!pc) {
          console.error(`Failed to create peer connection for ${sender}`);
          return;
        }
      }
      
      console.log(`Processing OFFER from ${sender}, current signaling state: ${pc.signalingState}`);
      
      // Check if we already have a remote description (avoid duplicate processing)
      if (pc.remoteDescription) {
        console.log(`Already have remote description for ${sender}, skipping duplicate OFFER`);
        return;
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
      console.log(`Remote description set for ${sender}`);
    
      // Setup sender transform if encryption is enabled and we have the key
      if (useEncryption && encryptionKeys[sender]) {
        console.log(`Setting up sender transform for encrypted connection with ${sender}`);
        setupSenderTransform(pc, sender);
      }
    
      console.log(`Creating answer for ${sender}...`);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`Answer created and local description set for ${sender}`);
      
      sendSignal({
        type: "ANSWER",
        sender: username,
        recipient: sender,
        data: answer,
        useEncryption: useEncryption && encryptionKeys[sender] ? true : null,
      });
      console.log(`ANSWER sent to ${sender}`);
    } else if (signal.type === "ANSWER") {
      if (!pc) {
        console.error(`No peer connection for ${sender} when receiving ANSWER - this should not happen!`);
        return;
      }
      console.log(`Processing ANSWER from ${sender}, current signaling state: ${pc.signalingState}`);
      
      // Check if we already have a remote description (avoid duplicate processing)
      if (pc.remoteDescription && pc.signalingState !== "have-local-offer") {
        console.log(`Already processed ANSWER from ${sender}, skipping duplicate`);
        return;
      }
      
      await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
      console.log(`Remote description (answer) set for ${sender}`);
      // After setting the answer, the connection is established from the offerer's side.
      // Now, the ICE candidates that were gathered can be sent.
      // This part is implicitly handled by the onicecandidate event handler,
      // but logging helps confirm the state.
      console.log(
        `Connection established with ${sender} after receiving answer. Connection state: ${pc.connectionState}, ICE state: ${pc.iceConnectionState}`
      );
    } else if (signal.type === "ICE") {
      if (!pc) {
        console.error(`No peer connection for ${sender} when receiving ICE`);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(signal.data));
    } else if (signal.type === "JOIN") {
      // This is a private message to a new user, telling them about an existing user.
      console.log(`Received private JOIN for existing user: ${sender}`, signal);
      addUserToList(sender);
      
      // Don't create peer connection automatically - wait for user to click Call
      // This prevents unwanted connections when users just join
      console.log(`User ${sender} added to list. Click "Call" button to start connection.`);
    } else if (signal.type === "CALL_REQUEST") {
      // Someone is calling us
      console.log(`Received CALL_REQUEST from ${sender}`);
      handleIncomingCall(sender);
    } else if (signal.type === "CALL_ACCEPTED") {
      // Our call was accepted
      console.log(`Call accepted by ${sender}`);
      handleCallAccepted(sender);
    } else if (signal.type === "CALL_REJECTED") {
      // Our call was rejected
      console.log(`Call rejected by ${sender}`);
      handleCallRejected(sender);
    } else if (signal.type === "CALL_ENDED") {
      // Call was ended by the other party
      console.log(`Call ended by ${sender}`);
      handleCallEnded(sender);
    } else if (signal.type === "KEY_EXCHANGE") {
      // Handle key exchange
      console.log(`Received key exchange from ${sender}`);
      await handleKeyExchange(sender, signal.data);
    } else if (signal.type === "ENCRYPTION_ENABLED") {
      // Peer confirmed encryption is enabled
      console.log(`Encryption enabled for connection with ${sender}`);
      updateEncryptionStatus();
    } else {
      console.warn("Received unknown signal type:", signal.type);
    }
  } catch (error) {
    console.error("Error processing private message:", error, payload);
  }
}

function createPeerConnection(otherUser, isOfferor) {
  console.log(`Creating PeerConnection for ${otherUser}`);
  const pc = new RTCPeerConnection(iceServers);
  peerConnections[otherUser] = pc;
  
  // Update user status
  updateUserConnectionStatus(otherUser);

  if (!localStream) {
    console.error("localStream is not available yet! Cannot add tracks.");
    return pc;
  }

  // Add local stream tracks to the peer connection
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Handle incoming remote tracks
  pc.ontrack = (event) => {
    console.log(`Track received from ${otherUser}`);
    console.log(`Audio call connected with ${otherUser}!`);

    // Setup receiver transform if encryption is enabled
    if (useEncryption && encryptionKeys[otherUser] && event.receiver && event.receiver.transform) {
      setupReceiverTransform(event.receiver, otherUser);
    }

    let remoteAudio = document.getElementById(`audio-${otherUser}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${otherUser}`;
      remoteAudio.autoplay = true;
      remoteAudio.controls = false;
      audioContainer.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
    // Explicitly call play() to handle browser autoplay policies
    remoteAudio
      .play()
      .then(() => {
        console.log(`Audio playing for ${otherUser}`);
        updateUserConnectionStatus(otherUser);
        // Show active call section
        showActiveCall(otherUser);
      })
      .catch((e) => {
        console.error(`Error playing remote audio for ${otherUser}:`, e);
        // Show a message to user that they need to interact with page to play audio
        alert("Please click anywhere on the page to allow audio playback");
      });
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`ICE candidate for ${otherUser}:`, event.candidate);
      sendSignal({
        type: "ICE",
        sender: username,
        recipient: otherUser,
        data: event.candidate,
      });
    } else {
      console.log(`ICE candidate gathering finished for ${otherUser}`);
    }
  };
  
  // Handle ICE connection state changes
  pc.oniceconnectionstatechange = () => {
    console.log(`ICE connection state changed for ${otherUser}: ${pc.iceConnectionState}`);
  };

  // If this peer is the one creating the offer
  if (isOfferor) {
    pc.onnegotiationneeded = async () => {
      await createOffer(pc, otherUser);
    };
    
    // Manually trigger negotiation after a short delay to ensure tracks are added
    setTimeout(async () => {
      if (pc.signalingState === "stable" && pc.connectionState !== "closed") {
        try {
          await createOffer(pc, otherUser);
        } catch (err) {
          console.error("Error creating initial offer:", err);
        }
      }
    }, 500);
  }

  return pc;
}

// Helper function to create and send offer
async function createOffer(pc, otherUser) {
  // Setup sender transform if encryption is enabled
  if (useEncryption && encryptionKeys[otherUser]) {
    setupSenderTransform(pc, otherUser);
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({
      type: "OFFER",
      sender: username,
      recipient: otherUser,
      data: offer,
      useEncryption: useEncryption && encryptionKeys[otherUser] ? true : null,
    });
    console.log(`Offer created and sent to ${otherUser}`);
  } catch (err) {
    console.error("Error creating offer:", err);
  }
}

// --- E2EE Functions using Insertable Streams ---

// Check if browser supports Insertable Streams API
function supportsInsertableStreams() {
  return typeof RTCRtpScriptTransform !== 'undefined' && 
         typeof TransformStream !== 'undefined';
}

// Generate a shared encryption key for a peer connection
async function generateEncryptionKey() {
  // Generate a random 256-bit key
  const keyMaterial = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  return keyMaterial;
}

// Export key for transmission
async function exportKey(key) {
  return await window.crypto.subtle.exportKey("raw", key);
}

// Import key from received data
async function importKey(keyData) {
  return await window.crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Exchange encryption key with peer
async function exchangeEncryptionKey(otherUser, isOfferor) {
  if (!supportsInsertableStreams()) {
    console.warn("Insertable Streams API not supported. Encryption disabled.");
    createPeerConnection(otherUser, isOfferor);
    return;
  }

  try {
    if (isOfferor) {
      // Generate a new key and send it to the peer
      const key = await generateEncryptionKey();
      encryptionKeys[otherUser] = key;
      
      const keyData = await exportKey(key);
      const keyArray = new Uint8Array(keyData);
      
      // Send key to peer (in production, use proper key exchange like ECDH)
      sendSignal({
        type: "KEY_EXCHANGE",
        sender: username,
        recipient: otherUser,
        data: Array.from(keyArray), // Convert to array for JSON serialization
      });
      
      console.log(`Encryption key generated and sent to ${otherUser}`);
      createPeerConnection(otherUser, isOfferor);
      updateEncryptionStatus();
    } else {
      // Wait for key from offeror
      console.log(`Waiting for encryption key from ${otherUser}`);
      createPeerConnection(otherUser, isOfferor);
    }
  } catch (error) {
    console.error("Key exchange failed:", error);
    // Fallback to unencrypted connection
    createPeerConnection(otherUser, isOfferor);
  }
}

// Handle received key exchange
async function handleKeyExchange(sender, keyData) {
  try {
    const keyArray = new Uint8Array(keyData);
    const key = await importKey(keyArray);
    encryptionKeys[sender] = key;
    
    console.log(`Encryption key received from ${sender}`);
    
    // Confirm encryption is enabled
    sendSignal({
      type: "ENCRYPTION_ENABLED",
      sender: username,
      recipient: sender,
    });
    
    // If we already have a peer connection, setup transforms
    const pc = peerConnections[sender];
    if (pc) {
      setupSenderTransform(pc, sender);
      
      // Setup receiver transform for existing tracks
      const receivers = pc.getReceivers();
      receivers.forEach(receiver => {
        if (receiver.track.kind === "audio" && receiver.transform) {
          setupReceiverTransform(receiver, sender);
        }
      });
    }
    
    updateEncryptionStatus();
  } catch (error) {
    console.error("Failed to import encryption key:", error);
  }
}

function setupSenderTransform(pc, otherUser) {
  if (!supportsInsertableStreams()) {
    console.warn("Insertable Streams API not supported");
    return;
  }

  const key = encryptionKeys[otherUser];
  if (!key) {
    console.warn("No encryption key available for", otherUser);
    return;
  }

  const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
  if (!sender || !sender.transform) {
    console.warn("Sender transform not available");
    return;
  }

  const transformStream = new TransformStream({
    async transform(encodedFrame, controller) {
      try {
        const iv = new Uint8Array(12);
        window.crypto.getRandomValues(iv); // Generate a new IV for each frame
        
        const encryptedData = await window.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: iv },
          key,
          encodedFrame.data
        );
        
        const newFrameData = new Uint8Array(iv.length + encryptedData.byteLength);
        newFrameData.set(iv, 0);
        newFrameData.set(new Uint8Array(encryptedData), iv.length);
        
        encodedFrame.data = newFrameData.buffer;
        controller.enqueue(encodedFrame);
      } catch (error) {
        console.error("Encryption error:", error);
        controller.error(error);
      }
    },
  });
  
  try {
    sender.transform = new RTCRtpScriptTransform(transformStream);
    console.log(`Sender transform setup for ${otherUser}`);
  } catch (error) {
    console.error("Failed to setup sender transform:", error);
  }
}

function setupReceiverTransform(receiver, otherUser) {
  if (!supportsInsertableStreams()) {
    console.warn("Insertable Streams API not supported");
    return;
  }

  const key = encryptionKeys[otherUser];
  if (!key) {
    console.warn("No encryption key available for", otherUser);
    return;
  }

  if (!receiver || !receiver.transform) {
    console.warn("Receiver transform not available");
    return;
  }

  const transformStream = new TransformStream({
    async transform(encodedFrame, controller) {
      try {
        if (encodedFrame.data.byteLength < 12) {
          // Frame too short, might not be encrypted
          controller.enqueue(encodedFrame);
          return;
        }

        const iv = new Uint8Array(encodedFrame.data, 0, 12);
        const encryptedData = new Uint8Array(encodedFrame.data, 12);
        
        const decryptedData = await window.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: iv },
          key,
          encryptedData
        );
        
        encodedFrame.data = decryptedData;
        controller.enqueue(encodedFrame);
      } catch (error) {
        console.error("Decryption error:", error);
        // On decryption failure, skip this frame
      }
    },
  });
  
  try {
    receiver.transform = new RTCRtpScriptTransform(transformStream);
    console.log(`Receiver transform setup for ${otherUser}`);
  } catch (error) {
    console.error("Failed to setup receiver transform:", error);
  }
}

function sendSignal(signal) {
  console.log(`Sending ${signal.type} signal to ${signal.recipient}:`, signal);
  try {
    stompClient.send("/app/signal.forward", {}, JSON.stringify(signal));
    console.log(`Signal sent successfully`);
  } catch (error) {
    console.error(`Error sending signal:`, error);
  }
}

function updateEncryptionStatus() {
  const encryptedConnections = Object.keys(encryptionKeys).length;
  if (useEncryption) {
    if (encryptedConnections > 0) {
      encryptionStatus.textContent = `🔒 Encryption Active (${encryptedConnections})`;
    } else {
      encryptionStatus.textContent = "🔒 Encryption Enabled";
    }
  } else {
    encryptionStatus.textContent = "🔓 Encryption Disabled";
  }
}

function updateUserCount() {
  const count = userList ? userList.children.length : 0;
  if (userCount) {
    userCount.textContent = `${count} user${count !== 1 ? 's' : ''}`;
  }
}

function addUserToList(user) {
  console.log(`Adding user to list: ${user}`);
  
  // Ensure userList exists
  if (!userList) {
    console.error("userList element not found!");
    userList = document.querySelector("#users");
    if (!userList) {
      console.error("Cannot find #users element!");
      return;
    }
  }
  
  // Check if user already exists
  if (document.getElementById(`user-${user}`)) {
    console.log(`User ${user} already in list`);
    return;
  }
  
  console.log(`Creating new user element for: ${user}`);
  const userElement = document.createElement("li");
  userElement.id = `user-${user}`;
  userElement.className = "user-item";
  
  const userInfoDiv = document.createElement("div");
  userInfoDiv.className = "user-item-info";
  
  const userNameSpan = document.createElement("div");
  userNameSpan.className = "user-item-name";
  userNameSpan.textContent = user;
  
  const statusDiv = document.createElement("div");
  statusDiv.className = "user-item-status";
  statusDiv.id = `status-${user}`;
  
  const statusDot = document.createElement("span");
  statusDot.className = "status-dot status-ready";
  
  const statusText = document.createElement("span");
  statusText.textContent = "Ready to call";
  
  statusDiv.appendChild(statusDot);
  statusDiv.appendChild(statusText);
  
  userInfoDiv.appendChild(userNameSpan);
  userInfoDiv.appendChild(statusDiv);
  
  const callButton = document.createElement("button");
  callButton.id = `call-btn-${user}`;
  callButton.className = "btn-call-action primary";
  callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
  callButton.onclick = () => initiateCall(user);
  
  userElement.appendChild(userInfoDiv);
  userElement.appendChild(callButton);
  userList.appendChild(userElement);
  
  console.log(`Successfully added ${user} to list. Total users: ${userList.children.length}`);
  updateUserCount();
  
  // Update status when connection state changes
  updateUserConnectionStatus(user);
}

function updateUserConnectionStatus(user) {
  const statusDiv = document.getElementById(`status-${user}`);
  const callButton = document.getElementById(`call-btn-${user}`);
  const pc = peerConnections[user];
  
  if (!pc) {
    if (statusDiv) {
      const dot = statusDiv.querySelector('.status-dot');
      const text = statusDiv.querySelector('span:last-child');
      if (dot) {
        dot.className = "status-dot status-ready";
      }
      if (text) {
        text.textContent = "Ready to call";
      }
    }
    if (callButton) {
      callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
      callButton.disabled = false;
      callButton.className = "btn-call-action primary";
    }
    return;
  }
  
  const updateStatus = () => {
    if (!statusDiv) return;
    
    const dot = statusDiv.querySelector('.status-dot');
    const text = statusDiv.querySelector('span:last-child');
    
    switch (pc.connectionState) {
      case "connecting":
        if (dot) dot.className = "status-dot status-connecting";
        if (text) text.textContent = "Connecting...";
        if (callButton) {
          callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Connecting';
          callButton.disabled = true;
        }
        break;
      case "connected":
        if (dot) dot.className = "status-dot status-connected";
        if (text) text.textContent = "Connected";
        if (callButton) {
          callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Connected';
          callButton.disabled = true;
          callButton.className = "btn-call-action primary";
        }
        // Show active call section
        showActiveCall(user);
        break;
      case "disconnected":
        if (dot) dot.className = "status-dot status-disconnected";
        if (text) text.textContent = "Disconnected";
        if (callButton) {
          callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
          callButton.disabled = false;
          callButton.className = "btn-call-action primary";
        }
        // Hide active call section
        hideActiveCall();
        break;
      case "failed":
        if (dot) dot.className = "status-dot status-disconnected";
        if (text) text.textContent = "Failed";
        if (callButton) {
          callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Retry';
          callButton.disabled = false;
          callButton.className = "btn-call-action primary";
        }
        break;
      case "closed":
        if (dot) dot.className = "status-dot status-disconnected";
        if (text) text.textContent = "Closed";
        if (callButton) {
          callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
          callButton.disabled = false;
          callButton.className = "btn-call-action primary";
        }
        break;
      default:
        if (text) text.textContent = pc.connectionState;
    }
  };
  
  // Update immediately
  updateStatus();
  
  // Listen for connection state changes
  pc.onconnectionstatechange = () => {
    updateStatus();
  };
  
    // Also listen for ice connection state
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        const dot = statusDiv?.querySelector('.status-dot');
        const text = statusDiv?.querySelector('span:last-child');
        if (dot) dot.className = "status-dot status-connected";
        if (text) text.textContent = "Connected";
        // Show active call section
        showActiveCall(user);
      } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        const dot = statusDiv?.querySelector('.status-dot');
        const text = statusDiv?.querySelector('span:last-child');
        if (dot) dot.className = "status-dot status-disconnected";
        if (text) text.textContent = "Connection issue";
        // Hide active call section if this was the active call
        if (activeCallWith === user) {
          hideActiveCall();
        }
      }
    };
}

// Function to manually initiate a call with a specific user
async function initiateCall(targetUser) {
  console.log(`Initiating call with ${targetUser}`);
  
  // Don't allow calling if we're already in a call or have an outgoing call
  if (outgoingCallTo || incomingCallFrom) {
    console.log("Already in a call or have an outgoing call");
    return;
  }
  
  // Check if we already have an active connection with this user
  if (peerConnections[targetUser] && peerConnections[targetUser].connectionState === "connected") {
    console.log("Already connected to this user");
    return;
  }
  
  outgoingCallTo = targetUser;
  
  // Update button state
  const callButton = document.getElementById(`call-btn-${targetUser}`);
  if (callButton) {
    callButton.disabled = true;
    callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Calling...';
  }
  
  // Show outgoing call modal
  if (outgoingCallTarget) {
    outgoingCallTarget.textContent = targetUser;
  }
  if (outgoingCallModal) {
    outgoingCallModal.classList.remove("hidden");
  }
  
  // Send call request
  sendSignal({
    type: "CALL_REQUEST",
    sender: username,
    recipient: targetUser,
    useEncryption: useEncryption
  });
  
  // Set timeout for call request (30 seconds)
  callTimeout = setTimeout(() => {
    if (outgoingCallTo === targetUser) {
      console.log(`Call request timeout for ${targetUser}`);
      handleCallTimeout(targetUser);
    }
  }, 30000);
}

// Handle incoming call request
function handleIncomingCall(callerUsername) {
  console.log(`Handling incoming call from ${callerUsername}`);
  
  // Don't show incoming call if we're already in a call
  if (outgoingCallTo || peerConnections[callerUsername]) {
    // Auto-reject if busy
    sendSignal({
      type: "CALL_REJECTED",
      sender: username,
      recipient: callerUsername
    });
    return;
  }
  
  incomingCallFrom = callerUsername;
  
  // Show incoming call modal
  if (callerNameElement) {
    callerNameElement.textContent = callerUsername;
  }
  if (callNotificationModal) {
    callNotificationModal.classList.remove("hidden");
  }
  
  // Play a notification sound (optional - browser may require user interaction first)
  // You can add a sound notification here if needed
}

// Handle call accepted (when someone accepts our call request)
async function handleCallAccepted(targetUser) {
  console.log(`Call accepted by ${targetUser}`);
  
  // Clear timeout
  if (callTimeout) {
    clearTimeout(callTimeout);
    callTimeout = null;
  }
  
  // Hide outgoing call modal
  if (outgoingCallModal) {
    outgoingCallModal.classList.add("hidden");
  }
  
  outgoingCallTo = null;
  
  // Update button
  const callButton = document.getElementById(`call-btn-${targetUser}`);
  if (callButton) {
    callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Connecting...';
  }
  
  // We initiated the call, so we are the offeror
  const isOfferor = true;
  console.log(`Call accepted! I am the offeror, creating peer connection and offer...`);
  
      if (useEncryption) {
        await exchangeEncryptionKey(targetUser, isOfferor);
      } else {
    const pc = createPeerConnection(targetUser, isOfferor);
    // We're the offeror, so create the offer
          setTimeout(async () => {
            try {
              await createOffer(pc, targetUser);
            } catch (err) {
        console.error("Error creating offer:", err);
            }
          }, 300);
        }
      }

// Handle call rejected
function handleCallRejected(targetUser) {
  console.log(`Call rejected by ${targetUser}`);
  
  // Clear timeout
  if (callTimeout) {
    clearTimeout(callTimeout);
    callTimeout = null;
  }
  
  // Hide outgoing call modal
  if (outgoingCallModal) {
    outgoingCallModal.classList.add("hidden");
  }
  
  outgoingCallTo = null;
  
  // Update button
  const callButton = document.getElementById(`call-btn-${targetUser}`);
  if (callButton) {
    callButton.disabled = false;
    callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
  }
  
  // Show notification
  alert(`Call to ${targetUser} was rejected`);
}

// Show active call section
function showActiveCall(user) {
  activeCallWith = user;
  if (activeCallName) {
    activeCallName.textContent = user;
  }
  if (activeCallStatus) {
    activeCallStatus.textContent = "Connected";
  }
  if (activeCallSection) {
    activeCallSection.classList.remove("hidden");
  }
}

// Hide active call section
function hideActiveCall() {
  activeCallWith = null;
  if (activeCallSection) {
    activeCallSection.classList.add("hidden");
  }
}

// End call function
function endCall(targetUser) {
  console.log(`Ending call with ${targetUser}`);
  
  // Close peer connection
  if (peerConnections[targetUser]) {
    peerConnections[targetUser].close();
    delete peerConnections[targetUser];
  }
  
  // Remove encryption key
  if (encryptionKeys[targetUser]) {
    delete encryptionKeys[targetUser];
    updateEncryptionStatus();
  }
  
  // Remove audio element
  const audioElement = document.getElementById(`audio-${targetUser}`);
  if (audioElement) {
    audioElement.remove();
  }
  
  // Send call ended signal
  sendSignal({
    type: "CALL_ENDED",
    sender: username,
    recipient: targetUser
  });
  
  // Hide active call section
  hideActiveCall();
  
  // Update UI
  updateUserConnectionStatus(targetUser);
  
  // Clear call state
  if (incomingCallFrom === targetUser) {
    incomingCallFrom = null;
    if (callNotificationModal) {
      callNotificationModal.classList.add("hidden");
    }
  }
  if (outgoingCallTo === targetUser) {
    outgoingCallTo = null;
    if (callTimeout) {
      clearTimeout(callTimeout);
      callTimeout = null;
    }
    if (outgoingCallModal) {
      outgoingCallModal.classList.add("hidden");
    }
  }
}

// Handle call ended
function handleCallEnded(targetUser) {
  console.log(`Call ended by ${targetUser}`);
  
  // Close peer connection
  if (peerConnections[targetUser]) {
    peerConnections[targetUser].close();
    delete peerConnections[targetUser];
  }
  
  // Remove encryption key
  if (encryptionKeys[targetUser]) {
    delete encryptionKeys[targetUser];
    updateEncryptionStatus();
  }
  
  // Remove audio element
  const audioElement = document.getElementById(`audio-${targetUser}`);
  if (audioElement) {
    audioElement.remove();
  }
  
  // Hide active call section
  hideActiveCall();
  
  // Update UI
  updateUserConnectionStatus(targetUser);
  
  // Clear call state
  if (incomingCallFrom === targetUser) {
    incomingCallFrom = null;
    if (callNotificationModal) {
      callNotificationModal.classList.add("hidden");
    }
  }
  if (outgoingCallTo === targetUser) {
    outgoingCallTo = null;
    if (outgoingCallModal) {
      outgoingCallModal.classList.add("hidden");
    }
  }
}

// Handle call timeout
function handleCallTimeout(targetUser) {
  console.log(`Call timeout for ${targetUser}`);
  
  if (callTimeout) {
    clearTimeout(callTimeout);
    callTimeout = null;
  }
  
  // Hide outgoing call modal
  if (outgoingCallModal) {
    outgoingCallModal.classList.add("hidden");
  }
  
  outgoingCallTo = null;
  
  // Update button
  const callButton = document.getElementById(`call-btn-${targetUser}`);
  if (callButton) {
    callButton.disabled = false;
    callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
  }
  
  alert(`Call to ${targetUser} timed out`);
}

function removeUser(user) {
  // Close peer connection
  if (peerConnections[user]) {
    peerConnections[user].close();
    delete peerConnections[user];
  }

  // Remove encryption key
  if (encryptionKeys[user]) {
    delete encryptionKeys[user];
    updateEncryptionStatus();
  }

  // Remove user from list
  const userElement = document.getElementById(`user-${user}`);
  if (userElement) {
    userElement.remove();
    updateUserCount();
  }

  // Remove audio element
  const audioElement = document.getElementById(`audio-${user}`);
  if (audioElement) {
    audioElement.remove();
  }
  
  // Hide active call section if this was the active call
  if (activeCallWith === user) {
    hideActiveCall();
  }
  
  // Clear call state if this user was involved
  if (incomingCallFrom === user) {
    incomingCallFrom = null;
    if (callNotificationModal) {
      callNotificationModal.classList.add("hidden");
    }
  }
  if (outgoingCallTo === user) {
    outgoingCallTo = null;
    if (callTimeout) {
      clearTimeout(callTimeout);
      callTimeout = null;
    }
    if (outgoingCallModal) {
      outgoingCallModal.classList.add("hidden");
    }
  }
}

function logout(event) {
  // Prevent the form from submitting immediately
  event.preventDefault();

  // Disconnect from WebSocket gracefully before logging out
  if (stompClient) {
    stompClient.disconnect(() => {
      console.log("Disconnected from WebSocket.");
      // Submit the form to perform the POST request for logout
      event.target.closest("form").submit();
    });
  } else {
    // If not connected, just submit the form
    event.target.closest("form").submit();
  }
}

// Function to request users list
function requestUsersList() {
  if (!stompClient || !stompClient.connected) {
    console.warn("WebSocket not connected. Cannot request users list.");
    return;
  }
  
  console.log("Manually requesting list of active users...");
  stompClient.send(
    "/app/signal.requestUsers",
    {},
    JSON.stringify({ 
      sender: username, 
      type: "REQUEST_USERS",
      useEncryption: useEncryption 
    })
  );
}

// Accept call button handler
if (acceptCallBtn) {
  acceptCallBtn.addEventListener("click", async () => {
    if (!incomingCallFrom) return;
    
    const caller = incomingCallFrom;
    incomingCallFrom = null;
    
    // Hide incoming call modal
    if (callNotificationModal) {
      callNotificationModal.classList.add("hidden");
    }
    
    // Send call accepted signal
    sendSignal({
      type: "CALL_ACCEPTED",
      sender: username,
      recipient: caller,
      useEncryption: useEncryption
    });
    
    // Create peer connection (we're the receiver, caller is the offeror)
    // The caller will create the offer, we just wait for it
    const isOfferor = false; // We're accepting, so we're NOT the offeror
    console.log(`Accepting call from ${caller}, caller will be the offeror`);
    
    if (useEncryption) {
      await exchangeEncryptionKey(caller, isOfferor);
    } else {
      createPeerConnection(caller, isOfferor);
      // As receiver, we wait for the offer from the caller
    }
    
    // Update button state
    const callButton = document.getElementById(`call-btn-${caller}`);
    if (callButton) {
      callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Connecting...';
      callButton.disabled = true;
    }
  });
}

// Reject call button handler
if (rejectCallBtn) {
  rejectCallBtn.addEventListener("click", () => {
    if (!incomingCallFrom) return;
    
    const caller = incomingCallFrom;
    incomingCallFrom = null;
    
    // Hide incoming call modal
    if (callNotificationModal) {
      callNotificationModal.classList.add("hidden");
    }
    
    // Send call rejected signal
    sendSignal({
      type: "CALL_REJECTED",
      sender: username,
      recipient: caller
    });
  });
}

// Cancel call button handler
if (cancelCallBtn) {
  cancelCallBtn.addEventListener("click", () => {
    if (!outgoingCallTo) return;
    
    const target = outgoingCallTo;
    outgoingCallTo = null;
    
    // Clear timeout
    if (callTimeout) {
      clearTimeout(callTimeout);
      callTimeout = null;
    }
    
    // Hide outgoing call modal
    if (outgoingCallModal) {
      outgoingCallModal.classList.add("hidden");
    }
    
    // Send call ended signal (or we could send CALL_REJECTED, but CALL_ENDED is more appropriate for cancelling)
    sendSignal({
      type: "CALL_ENDED",
      sender: username,
      recipient: target
    });
    
    // Update button
    const callButton = document.getElementById(`call-btn-${target}`);
    if (callButton) {
      callButton.disabled = false;
      callButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg> Call';
    }
  });
}

// End call button handler
if (endCallBtn) {
  endCallBtn.addEventListener("click", () => {
    if (activeCallWith) {
      endCall(activeCallWith);
    }
  });
}

// Automatically connect when the page loads
document.addEventListener("DOMContentLoaded", () => {
  username = usernamePage.getAttribute("data-username");
  if (logoutButton) {
  logoutButton.addEventListener("click", logout);
  }
  if (refreshUsersBtn) {
    refreshUsersBtn.addEventListener("click", requestUsersList);
  }
  if (username) {
    // We can directly trigger the connect logic or just have a "Join" button
    usernameForm.addEventListener("submit", connect);
  }
});

window.onbeforeunload = () => {
  if (stompClient) {
    // Gracefully leave
    stompClient.send(
      "/app/signal.leave",
      {},
      JSON.stringify({ sender: username, type: "LEAVE" })
    );
  }
};

function onError(error) {
  connectingElement.textContent =
    "Could not connect to WebSocket server. Please refresh this page to try again!";
  connectingElement.style.color = "red";
  console.error("STOMP Error:", error);
}
