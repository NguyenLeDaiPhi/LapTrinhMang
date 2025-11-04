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

let stompClient = null;
let username = null;
let localStream;

// Storing peer connections: { 'otherUser': RTCPeerConnection }
const peerConnections = {};

// For E2EE - Store encryption keys per peer connection
let useEncryption = false;
const encryptionKeys = {}; // { 'otherUser': CryptoKey }

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
    encryptionStatus.textContent = "🔒 Encryption: Enabled (waiting for peer connection)";
    encryptionStatus.style.color = "#4CAF50";
  } else {
    encryptionStatus.textContent = "🔓 Encryption: Disabled";
    encryptionStatus.style.color = "#666";
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
      encryptionStatus.textContent = `🔒 Encryption: Active (${encryptedConnections} encrypted connection(s))`;
      encryptionStatus.style.color = "#4CAF50";
    } else {
      encryptionStatus.textContent = "🔒 Encryption: Enabled (waiting for peer)";
      encryptionStatus.style.color = "#FF9800";
    }
  } else {
    encryptionStatus.textContent = "🔓 Encryption: Disabled";
    encryptionStatus.style.color = "#666";
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
  userElement.style.display = "flex";
  userElement.style.justifyContent = "space-between";
  userElement.style.alignItems = "center";
  userElement.style.marginBottom = "10px";
  userElement.style.padding = "8px";
  userElement.style.border = "1px solid #ddd";
  userElement.style.borderRadius = "4px";
  
  const userInfoDiv = document.createElement("div");
  userInfoDiv.style.display = "flex";
  userInfoDiv.style.flexDirection = "column";
  userInfoDiv.style.flex = "1";
  
  const userNameSpan = document.createElement("span");
  userNameSpan.textContent = user;
  userNameSpan.style.fontWeight = "bold";
  
  const statusSpan = document.createElement("span");
  statusSpan.id = `status-${user}`;
  statusSpan.textContent = "● Ready to call";
  statusSpan.style.fontSize = "0.85em";
  statusSpan.style.color = "#4CAF50";
  
  userInfoDiv.appendChild(userNameSpan);
  userInfoDiv.appendChild(statusSpan);
  
  const callButton = document.createElement("button");
  callButton.id = `call-btn-${user}`;
  callButton.textContent = "📞 Call";
  callButton.style.padding = "5px 15px";
  callButton.style.backgroundColor = "#4CAF50";
  callButton.style.color = "white";
  callButton.style.border = "none";
  callButton.style.borderRadius = "4px";
  callButton.style.cursor = "pointer";
  callButton.onclick = () => initiateCall(user);
  
  userElement.appendChild(userInfoDiv);
  userElement.appendChild(callButton);
  userList.appendChild(userElement);
  
  console.log(`Successfully added ${user} to list. Total users: ${userList.children.length}`);
  
  // Update status when connection state changes
  updateUserConnectionStatus(user);
}

function updateUserConnectionStatus(user) {
  const statusSpan = document.getElementById(`status-${user}`);
  const callButton = document.getElementById(`call-btn-${user}`);
  const pc = peerConnections[user];
  
  if (!pc) {
    if (statusSpan) {
      statusSpan.textContent = "● Ready to call";
      statusSpan.style.color = "#4CAF50";
    }
    if (callButton) {
      callButton.textContent = "📞 Call";
      callButton.style.backgroundColor = "#4CAF50";
      callButton.disabled = false;
    }
    return;
  }
  
  const updateStatus = () => {
    if (!statusSpan) return;
    
    switch (pc.connectionState) {
      case "connecting":
        statusSpan.textContent = "● Connecting...";
        statusSpan.style.color = "#FF9800";
        if (callButton) {
          callButton.textContent = "⏳ Connecting";
          callButton.style.backgroundColor = "#FF9800";
          callButton.disabled = true;
        }
        break;
      case "connected":
        statusSpan.textContent = "● Connected";
        statusSpan.style.color = "#4CAF50";
        if (callButton) {
          callButton.textContent = "✓ Connected";
          callButton.style.backgroundColor = "#4CAF50";
          callButton.disabled = true;
        }
        break;
      case "disconnected":
        statusSpan.textContent = "● Disconnected";
        statusSpan.style.color = "#f44336";
        if (callButton) {
          callButton.textContent = "📞 Call";
          callButton.style.backgroundColor = "#4CAF50";
          callButton.disabled = false;
        }
        break;
      case "failed":
        statusSpan.textContent = "● Failed";
        statusSpan.style.color = "#f44336";
        if (callButton) {
          callButton.textContent = "📞 Retry";
          callButton.style.backgroundColor = "#f44336";
          callButton.disabled = false;
        }
        break;
      case "closed":
        statusSpan.textContent = "● Closed";
        statusSpan.style.color = "#999";
        if (callButton) {
          callButton.textContent = "📞 Call";
          callButton.style.backgroundColor = "#4CAF50";
          callButton.disabled = false;
        }
        break;
      default:
        statusSpan.textContent = "● " + pc.connectionState;
        statusSpan.style.color = "#999";
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
      if (statusSpan) {
        statusSpan.textContent = "● Connected";
        statusSpan.style.color = "#4CAF50";
      }
    } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      if (statusSpan) {
        statusSpan.textContent = "● Connection issue";
        statusSpan.style.color = "#f44336";
      }
    }
  };
}

// Function to manually initiate a call with a specific user
async function initiateCall(targetUser) {
  console.log(`Initiating call with ${targetUser}`);
  
  const callButton = document.getElementById(`call-btn-${targetUser}`);
  if (callButton) {
    callButton.disabled = true;
    callButton.textContent = "⏳ Calling...";
    callButton.style.backgroundColor = "#FF9800";
  }
  
  // Check if peer connection already exists
  let pc = peerConnections[targetUser];
  
  if (!pc) {
    console.log(`No existing peer connection for ${targetUser}, creating new one...`);
    // Determine who should be the offeror
    const isOfferor = username < targetUser;
    console.log(`I will be the offeror: ${isOfferor}`);
    
    // Check if both want encryption
    // For manual calls, we'll use the current encryption setting
    if (useEncryption) {
      // If encryption is enabled, do key exchange first
      console.log(`Encryption enabled, initiating key exchange...`);
      await exchangeEncryptionKey(targetUser, isOfferor);
    } else {
      console.log(`Creating peer connection without encryption...`);
      pc = createPeerConnection(targetUser, isOfferor);
      
      // If we're the offeror, manually trigger offer creation
      if (isOfferor) {
        console.log(`I'm the offeror, creating offer immediately...`);
        setTimeout(async () => {
          try {
            await createOffer(pc, targetUser);
          } catch (err) {
            console.error("Error creating offer in initiateCall:", err);
            if (callButton) {
              callButton.disabled = false;
              callButton.textContent = "📞 Call";
              callButton.style.backgroundColor = "#4CAF50";
            }
          }
        }, 300);
      }
    }
  } else {
    console.log(`Peer connection already exists for ${targetUser}, state: ${pc.signalingState}`);
    // If connection exists but is in stable state, create new offer
    if (pc.signalingState === "stable" && pc.connectionState !== "closed") {
      const isOfferor = username < targetUser;
      if (isOfferor) {
        console.log(`Connection is stable, creating new offer...`);
        await createOffer(pc, targetUser);
      } else {
        console.log(`Not the offeror, waiting for offer from ${targetUser}`);
      }
    } else if (pc.connectionState === "closed" || pc.connectionState === "failed") {
      // Recreate connection if it was closed or failed
      console.log(`Connection is ${pc.connectionState}, recreating...`);
      delete peerConnections[targetUser];
      const isOfferor = username < targetUser;
      if (useEncryption) {
        await exchangeEncryptionKey(targetUser, isOfferor);
      } else {
        pc = createPeerConnection(targetUser, isOfferor);
        if (isOfferor) {
          setTimeout(async () => {
            try {
              await createOffer(pc, targetUser);
            } catch (err) {
              console.error("Error creating offer after reconnect:", err);
            }
          }, 300);
        }
      }
    }
  }
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
  }

  // Remove audio element
  const audioElement = document.getElementById(`audio-${user}`);
  if (audioElement) {
    audioElement.remove();
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

// Automatically connect when the page loads
document.addEventListener("DOMContentLoaded", () => {
  username = usernamePage.getAttribute("data-username");
  logoutButton.addEventListener("click", logout);
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
