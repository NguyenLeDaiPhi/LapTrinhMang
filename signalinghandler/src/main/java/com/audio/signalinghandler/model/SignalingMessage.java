package com.audio.signalinghandler.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@AllArgsConstructor
@NoArgsConstructor
@Builder
public class SignalingMessage {
    private String sender;
    private String recipient;
    private SignalType type;
    private Object data; // Can be SDP offer, answer, ICE candidate, or encryption key
    private Boolean useEncryption; // Flag to indicate if encryption is enabled
}
