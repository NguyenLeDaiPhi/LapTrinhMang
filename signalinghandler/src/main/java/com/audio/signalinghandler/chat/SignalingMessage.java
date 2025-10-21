package com.audio.signalinghandler.chat;

import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@AllArgsConstructor
@NoArgsConstructor
public class SignalingMessage {
    private String sender;
    private String recipient;
    private SignalType type;
    private Object data; // Can be SDP offer, answer, or ICE candidate
}
