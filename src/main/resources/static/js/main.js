"use strict";

const usernamePage = document.querySelector("#username-page");
const chatPage = document.querySelector("#chat-page");
const usernameForm = document.querySelector("#usernameForm");
const yourUsernameSpan = document.querySelector("#your-username");
const userList = document.querySelector("#users");
const connectingElement = document.querySelector(".connecting");
const audioContainer = document.querySelector("#audio-container");
const startRecordBtn = document.querySelector("#start-record-btn");
const stopRecordBtn = document.querySelector("#stop-record-btn");
const recordingsList = document.querySelector("#recordings-list");

let stompClient = null;
let username = null;
let localStream;

// Storing peer connections: { 'otherUser': RTCPeerConnection }
const peerConnections = {};

// Recording variables
let mediaRecorder;
let recordedChunks = [];
let audioContext;
let mixedStreamDestination;

const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function connect(event) {
  username = document.querySelector("#name").value.trim();

  if (username) {
    usernamePage.classList.add("hidden");
    chatPage.classList.remove("hidden");
    yourUsernameSpan.textContent = username;

    const socket = new SockJS("/ws");
    stompClient = Stomp.over(socket);

    stompClient.connect({}, onConnected, onError);
  }
  event.preventDefault();
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

  // --- Recording Setup ---
  audioContext = new AudioContext();
  mixedStreamDestination = audioContext.createMediaStreamDestination();
  // Add local stream to the mixer
  audioContext
    .createMediaStreamSource(localStream)
    .connect(mixedStreamDestination);

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

function onError(error) {
  connectingElement.textContent =
    "Could not connect to WebSocket server. Please refresh this page to try again!";
  connectingElement.style.color = "red";
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
    let remoteAudio = document.getElementById(`audio-${otherUser}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${otherUser}`;
      remoteAudio.autoplay = true;
      audioContainer.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
    // Add remote stream to the mixer for recording
    audioContext
      .createMediaStreamSource(event.streams[0])
      .connect(mixedStreamDestination);
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

// --- Recording Logic ---

startRecordBtn.onclick = () => {
  if (mixedStreamDestination.stream.getAudioTracks().length === 0) {
    alert("Không có âm thanh để ghi.");
    return;
  }
  mediaRecorder = new MediaRecorder(mixedStreamDestination.stream);
  mediaRecorder.start();
  console.log("Bắt đầu ghi âm.");

  recordedChunks = []; // Reset chunks

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);

    // Create a new div to hold the recording controls
    const recordingItem = document.createElement("div");
    recordingItem.classList.add("recording-item"); // Add a class for potential styling

    // Create a playable audio element
    const audioPlayer = document.createElement("audio");
    audioPlayer.controls = true;
    audioPlayer.src = url;
    recordingItem.appendChild(audioPlayer);

    // Create a download link
    const a = document.createElement("a");
    a.href = url;
    a.download = `recording-${new Date().toISOString()}.webm`;
    a.textContent = `Tải xuống bản ghi âm (${new Date().toLocaleTimeString()})`;
    recordingItem.appendChild(a);

    recordingsList.appendChild(recordingItem);
  };

  startRecordBtn.disabled = true;
  stopRecordBtn.disabled = false;
};

stopRecordBtn.onclick = () => {
  mediaRecorder.stop();
  console.log("Dừng ghi âm.");
  startRecordBtn.disabled = false;
  stopRecordBtn.disabled = true;
};

usernameForm.addEventListener("submit", connect, true);

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
