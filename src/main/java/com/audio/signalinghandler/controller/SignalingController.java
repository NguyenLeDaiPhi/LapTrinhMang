package com.audio.signalinghandler.controller;

import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.stereotype.Controller;

import com.audio.signalinghandler.chat.SignalingMessage;

import lombok.RequiredArgsConstructor;

@Controller
@RequiredArgsConstructor
public class SignalingController {

    private final SimpMessageSendingOperations messagingTemplate;

    @MessageMapping("/signal.join")
    public void join(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        // Store username in session
        headerAccessor.getSessionAttributes().put("username", message.getSender());
        // Broadcast to all that a new user has joined
        messagingTemplate.convertAndSend("/topic/public", message);
    }

    @MessageMapping("/signal.forward")
    public void forward(@Payload SignalingMessage message) {
        // Forward the message (offer, answer, ICE candidate) to the specific recipient
        messagingTemplate.convertAndSendToUser(
                message.getRecipient(), "/queue/signals", message);
    }
}
