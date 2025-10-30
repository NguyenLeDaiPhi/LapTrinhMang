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
    stompClient.subscribe("/topic/public", onPublicMessageReceived);
    stompClient.subscribe(
      `/user/${username}/queue/signals`,
      onPrivateMessageReceived
    );

    // 5. Announce our presence to others
    stompClient.send(
      "/app/signal.join",
      {},
      JSON.stringify({ sender: username, type: "JOIN" })
    );
  } catch (error) {
    console.error("Failed to connect or get media:", error);
    alert("Could not connect. Please check permissions and refresh the page.");
    connectingElement.textContent = "Failed to connect";
  }
}

function onPublicMessageReceived(payload) {
  const message = JSON.parse(payload.body);
  if (message.type === "JOIN" && message.sender !== username) {
    console.log(`New user joined: ${message.sender}`);
    addUserToList(message.sender);
    const isOfferor = username < message.sender;
    console.log(`Should I be the offeror for ${message.sender}? ${isOfferor}`);
    createPeerConnection(message.sender, isOfferor);
  } else if (message.type === "LEAVE" && message.sender !== username) {
    console.log(`User left: ${message.sender}`);
    removeUser(message.sender);
  }
}

async function onPrivateMessageReceived(payload) {
  const signal = JSON.parse(payload.body);
  const sender = signal.sender;

  console.log(`Signal received from ${sender}`, signal);

  let pc = peerConnections[sender];
  if (pc === undefined && signal.type === "OFFER") {
    // If we are the receiver of the offer, create a peer connection.
    // The createPeerConnection function stores the new pc in the peerConnections map.
    // We then need to retrieve it from the map for the 'pc' variable in this scope.
    createPeerConnection(sender, false);
    pc = peerConnections[sender];
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
    // After setting the answer, the connection is established from the offerer's side.
    // Now, the ICE candidates that were gathered can be sent.
    // This part is implicitly handled by the onicecandidate event handler,
    // but logging helps confirm the state.
    console.log(
      `Connection established with ${sender} after receiving answer.`
    );
  } else if (signal.type === "ICE") {
    await pc.addIceCandidate(new RTCIceCandidate(signal.data));
  } else if (signal.type === "JOIN") {
    // This is a private message to a new user, telling them about an existing user.
    console.log(`Received private JOIN for existing user: ${sender}`);
    addUserToList(sender);
    const isOfferor = username < sender;
    console.log(`Should I be the offeror for ${sender}? ${isOfferor}`);
    createPeerConnection(sender, isOfferor);
  } else {
    console.warn("Received unknown signal type:", signal.type);
  }
}

function createPeerConnection(otherUser, isOfferor) {
  console.log(`Creating PeerConnection for ${otherUser}`);
  const pc = new RTCPeerConnection(iceServers);
  peerConnections[otherUser] = pc;

  if (!localStream) {
    console.error("localStream is not available yet! Cannot add tracks.");
    return pc;
  }

  // Add local stream tracks to the peer connection
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Handle incoming remote tracks
  pc.ontrack = (event) => {
    console.log(`Track received from ${otherUser}`);

    // if (useEncryption && event.streams[0] && event.receiver.transform) {
    //   setupReceiverTransform(event.receiver);
    // }

    let remoteAudio = document.getElementById(`audio-${otherUser}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${otherUser}`;
      audioContainer.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
    // Explicitly call play() to handle browser autoplay policies
    remoteAudio
      .play()
      .catch((e) =>
        console.error(`Error playing remote audio for ${otherUser}:`, e)
      );
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
      // if (useEncryption) {
      //   setupSenderTransform(pc);
      // }

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

/* E2EE is complex and disabled for now to ensure basic functionality works.

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

*/

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

// Automatically connect when the page loads
document.addEventListener("DOMContentLoaded", () => {
  username = usernamePage.getAttribute("data-username");
  logoutButton.addEventListener("click", logout);
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
