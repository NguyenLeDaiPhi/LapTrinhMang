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

let stompClient = null;
let username = null;
let localStream;

// Storing peer connections: { 'otherUser': RTCPeerConnection }
const peerConnections = {};

// For E2EE
let useEncryption = false;
let encryptionKey;

const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function connect(event) {
  username = usernamePage.getAttribute("data-username");
  useEncryption = encryptCheckbox.checked;
  event.preventDefault();

  if (username != null) {
    usernamePage.classList.add("hidden");
    chatPage.classList.remove("hidden");
    yourUsernameSpan.textContent = username;

    const socket = new SockJS("/ws");
    stompClient = Stomp.over(socket);

    stompClient.connect(
      {},
      async () => {
        if (useEncryption) {
          await setupEncryptionKey();
        }
        onConnected();
      },
      onError
    );
  }
}

async function onConnected() {
  connectingElement.classList.add("hidden");

  // Get local audio stream
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    const localAudio = document.createElement("audio");
    localAudio.srcObject = localStream;
    localAudio.id = "local-audio";
    localAudio.muted = true; // Mute self to avoid feedback
    localAudio.play();
    audioContainer.appendChild(localAudio);
  } catch (error) {
    console.error("Error accessing media devices.", error);
    alert("Could not access your microphone. Please check permissions.");
    return;
  }

  // Subscribe to the Public Topic to get user join/leave notifications
  stompClient.subscribe("/topic/public", onPublicMessageReceived);

  // Subscribe to the Private Queue for signaling messages
  stompClient.subscribe(
    `/user/${username}/queue/signals`,
    onPrivateMessageReceived
  );

  // Tell your name to the server
  stompClient.send(
    "/app/signal.join",
    {},
    JSON.stringify({ sender: username, type: "JOIN" })
  );
}

function onPublicMessageReceived(payload) {
  const message = JSON.parse(payload.body);

  if (message.type === "JOIN" && message.sender !== username) {
    console.log(`New user joined: ${message.sender}`);
    addUserToList(message.sender);
    // Create an offer to the new user
    createPeerConnection(message.sender, true);
  } else if (message.type === "LEAVE") {
    console.log(`User left: ${message.sender}`);
    removeUser(message.sender);
  }
}

async function onPrivateMessageReceived(payload) {
  const signal = JSON.parse(payload.body);
  const sender = signal.sender;

  console.log(`Signal received from ${sender}`, signal);

  let pc = peerConnections[sender];
  if (pc === undefined) {
    // If we are the receiver of the offer
    pc = createPeerConnection(sender, false);
  }

  if (signal.type === "OFFER") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({
      type: "ANSWER",
      sender: username,
      recipient: sender,
      data: answer,
    });
  } else if (signal.type === "ANSWER") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
  } else if (signal.type === "ICE") {
    await pc.addIceCandidate(new RTCIceCandidate(signal.data));
  }
}

function createPeerConnection(otherUser, isOfferor) {
  console.log(`Creating PeerConnection for ${otherUser}`);
  const pc = new RTCPeerConnection(iceServers);
  peerConnections[otherUser] = pc;

  // Add local stream tracks to the peer connection
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Handle incoming remote tracks
  pc.ontrack = (event) => {
    console.log(`Track received from ${otherUser}`);

    if (useEncryption && event.streams[0] && event.receiver.transform) {
      setupReceiverTransform(event.receiver);
    }

    let remoteAudio = document.getElementById(`audio-${otherUser}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${otherUser}`;
      remoteAudio.autoplay = true;
      audioContainer.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({
        type: "ICE",
        sender: username,
        recipient: otherUser,
        data: event.candidate,
      });
    }
  };

  // If this peer is the one creating the offer
  if (isOfferor) {
    pc.onnegotiationneeded = async () => {
      if (useEncryption) {
        setupSenderTransform(pc);
      }

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({
          type: "OFFER",
          sender: username,
          recipient: otherUser,
          data: offer,
        });
      } catch (err) {
        console.error(err);
      }
    };
  }

  return pc;
}

// --- E2EE Functions using Insertable Streams ---

async function setupEncryptionKey() {
  // This is a simplified key management. In a real app, use a secure key exchange mechanism.
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("a-very-secret-key-that-should-be-exchanged"), // Use a more secure, exchanged key
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  encryptionKey = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("some-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  console.log("Encryption key set up.");
}

function setupSenderTransform(pc) {
  const sender = pc.getSenders().find((s) => s.track.kind === "audio");
  if (!sender || !sender.transform) return;

  const transformStream = new TransformStream({
    async transform(encodedFrame, controller) {
      const iv = new Uint8Array(12);
      window.crypto.getRandomValues(iv); // Generate a new IV for each frame
      const encryptedData = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        encryptionKey,
        encodedFrame.data
      );
      const newFrameData = new Uint8Array(iv.length + encryptedData.byteLength);
      newFrameData.set(iv, 0);
      newFrameData.set(new Uint8Array(encryptedData), iv.length);
      encodedFrame.data = newFrameData.buffer;
      controller.enqueue(encodedFrame);
    },
  });
  sender.transform = new RTCRtpScriptTransform(transformStream);
}

function setupReceiverTransform(receiver) {
  if (!receiver || !receiver.transform) return;
  const transformStream = new TransformStream({
    async transform(encodedFrame, controller) {
      const iv = new Uint8Array(encodedFrame.data, 0, 12);
      const data = new Uint8Array(encodedFrame.data, 12);
      encodedFrame.data = await window.crypto.subtle
        .decrypt({ name: "AES-GCM", iv: iv }, encryptionKey, data)
        .catch((e) => {
          console.error("Decryption failed:", e);
          return null;
        });
      if (encodedFrame.data) controller.enqueue(encodedFrame);
    },
  });
  receiver.transform = new RTCRtpScriptTransform(transformStream);
}

function sendSignal(signal) {
  stompClient.send("/app/signal.forward", {}, JSON.stringify(signal));
}

function addUserToList(user) {
  if (!document.getElementById(`user-${user}`)) {
    const userElement = document.createElement("li");
    userElement.id = `user-${user}`;
    userElement.textContent = user;
    userList.appendChild(userElement);
  }
}

function removeUser(user) {
  // Close peer connection
  if (peerConnections[user]) {
    peerConnections[user].close();
    delete peerConnections[user];
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

function logout() {
  // Disconnect from WebSocket gracefully before logging out
  if (stompClient) {
    stompClient.disconnect(() => {
      console.log("Disconnected from WebSocket.");
      // Submit the form to perform the POST request for logout
      document.querySelector("#logout-form").submit();
    });
  } else {
    // If not connected, just submit the form
    document.querySelector("#logout-form").submit();
  }
}

// Automatically connect when the page loads
document.addEventListener("DOMContentLoaded", () => {
  username = usernamePage.getAttribute("data-username");
  if (username) {
    // We can directly trigger the connect logic or just have a "Join" button
    usernameForm.addEventListener("submit", connect, true);
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

logoutButton.addEventListener("click", logout, true);
