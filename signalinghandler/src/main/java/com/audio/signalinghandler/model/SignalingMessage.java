package com.audio.signalinghandler.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class SignalingMessage {
    private String sender;
    private String recipient;
    private String type;
    private Object data;
    private String roomId;
}
