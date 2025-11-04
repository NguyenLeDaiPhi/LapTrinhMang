package com.audio.signalinghandler.controller;

import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.stereotype.Controller;
import lombok.extern.slf4j.Slf4j;

import com.audio.signalinghandler.model.SignalingMessage;
import com.audio.signalinghandler.model.SignalType;
import lombok.RequiredArgsConstructor;

import java.util.HashSet;
import java.util.Set;

@Controller
@RequiredArgsConstructor
@Slf4j
public class SignalingController {

    private final SimpMessageSendingOperations messagingTemplate;
    // A simple in-memory store for active users.
    private static final Set<String> activeUsers = new HashSet<>(); // Must be static
    
    public static Set<String> getActiveUsers() {
        return activeUsers;
    }

    @MessageMapping("/signal.join")
    public void join(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        String newUser = message.getSender();
        log.info("User {} joining. Current active users: {}", newUser, activeUsers);
        
        // Add the new user to the active list and session FIRST
        activeUsers.add(newUser);
        headerAccessor.getSessionAttributes().put("username", newUser);
        log.info("User {} added to active users. Total: {}", newUser, activeUsers.size());

        // Announce the new user to existing users (with encryption preference)
        log.info("Announcing new user {} to all existing users via /topic/public", newUser);
        messagingTemplate.convertAndSend("/topic/public", message);
        
        // Send the list of existing users to the new user
        // Use public topic with USER_LIST type so client can filter
        new Thread(() -> {
            try {
                Thread.sleep(500); // Wait 500ms for subscription to be ready
                log.info("Sending existing users list to new user {} via public topic", newUser);
                for (String existingUser : activeUsers) {
                    if (!existingUser.equals(newUser)) {
                        SignalingMessage existingUserMessage = SignalingMessage.builder()
                                .sender(existingUser)
                                .recipient(newUser)
                                .type(SignalType.USER_LIST)
                                .data(null)
                                .useEncryption(message.getUseEncryption())
                                .build();
                        
                        log.info("Broadcasting existing user {} info via /topic/public (for user {})", 
                                existingUser, newUser);
                        messagingTemplate.convertAndSend("/topic/public", existingUserMessage);
                    }
                }
                log.info("Finished broadcasting existing users list");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                log.error("Thread interrupted while sending user list", e);
            }
        }).start();
    }

    @MessageMapping("/signal.forward")
    public void forward(@Payload SignalingMessage message) {
        // Forward the message (offer, answer, ICE candidate) to the specific recipient
        String sender = message.getSender();
        String recipient = message.getRecipient();
        SignalType type = message.getType();
        
        log.info("Forwarding {} message from {} to {}", type, sender, recipient);
        
        // Try private queue first
        try {
            messagingTemplate.convertAndSendToUser(recipient, "/queue/signals", message);
            log.info("Sent {} message from {} to {} via /user/{}/queue/signals", 
                    type, sender, recipient, recipient);
        } catch (Exception e) {
            log.warn("Failed to send via private queue: {}", e.getMessage());
        }
        
        // Also send via public topic as fallback/backup
        // Client will filter by recipient field
        log.info("Also sending {} message from {} to {} via /topic/public (with recipient filter)", 
                type, sender, recipient);
        messagingTemplate.convertAndSend("/topic/public", message);
    }
    
    @MessageMapping("/signal.requestUsers")
    public void requestUsers(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        String requestingUser = message.getSender();
        log.info("User {} requesting list of active users. Current active users: {}", requestingUser, activeUsers);
        
        // Send all active users (except the requesting user) via public topic
        // Client will filter by recipient field
        int sentCount = 0;
        for (String activeUser : activeUsers) {
            if (!activeUser.equals(requestingUser)) {
                SignalingMessage userInfo = SignalingMessage.builder()
                        .sender(activeUser)
                        .recipient(requestingUser)
                        .type(SignalType.USER_LIST)
                        .data(null)
                        .useEncryption(message.getUseEncryption())
                        .build();
                
                log.info("Broadcasting user {} info via /topic/public (for requesting user {})", 
                        activeUser, requestingUser);
                messagingTemplate.convertAndSend("/topic/public", userInfo);
                sentCount++;
            }
        }
        log.info("Broadcasted {} user(s) via public topic for requesting user {}", sentCount, requestingUser);
    }
}
