package com.audio.signalinghandler.controller;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.stereotype.Controller;

import com.audio.signalinghandler.model.SignalingMessage;
import com.audio.signalinghandler.model.SignalType;
import lombok.AllArgsConstructor;

import lombok.RequiredArgsConstructor;

import java.util.HashSet;
import java.util.List;
import java.util.ArrayList;
import java.util.Set;

@Controller
@RequiredArgsConstructor
public class SignalingController {

    private final SimpMessageSendingOperations messagingTemplate;
    // A simple in-memory store for active users.
    private static final Set<String> activeUsers = new HashSet<>(); // Must be static
    
    public static Set<String> getActiveUsers() {
        return activeUsers;
    }

    @MessageMapping("/signal.join")
    public void join(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        // Send the list of existing users to the new user
        // We must do this BEFORE adding the new user to the list
        activeUsers.forEach(user -> {
            SignalingMessage existingUserMessage = new SignalingMessage(user, message.getSender(), SignalType.JOIN, null);
            messagingTemplate.convertAndSendToUser(message.getSender(), "/queue/signals", existingUserMessage);
        });

        // Add the new user to the active list and session
        activeUsers.add(message.getSender());
        headerAccessor.getSessionAttributes().put("username", message.getSender());

        // Announce the new user to existing users
        messagingTemplate.convertAndSend("/topic/public", message);
    }

    @MessageMapping("/signal.forward")
    public void forward(@Payload SignalingMessage message) {
        // Forward the message (offer, answer, ICE candidate) to the specific recipient
        messagingTemplate.convertAndSendToUser(
                message.getRecipient(), "/queue/signals", message);
    }
}
