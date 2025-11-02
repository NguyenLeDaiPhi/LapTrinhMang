package com.audio.signalinghandler.controller;

import com.audio.signalinghandler.model.SignalingMessage;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.stereotype.Controller;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Controller
@RequiredArgsConstructor
@Slf4j
public class SignalingController {

    private final SimpMessageSendingOperations messagingTemplate;

    // In-memory store for rooms and their participants. Key: roomId, Value: Set of usernames
    private static final Map<String, Set<String>> rooms = new ConcurrentHashMap<>();
    // In-memory store to track which room a user is in. Key: username, Value: roomId
    private static final Map<String, String> userRoomMap = new ConcurrentHashMap<>();

    /**
     * Handles a user joining a room.
     * If the room doesn't exist, it is created.
     * The new user is notified of existing users, and existing users are notified of the new user.
     */
    @MessageMapping("/signal.joinRoom")
    public void joinRoom(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        // Get the username from the WebSocket session, NOT from the message payload.
        // This is a critical security measure.
        String username = headerAccessor.getUser().getName();
        if (username == null) {
            log.error("Username is null in session attributes. Cannot join room.");
            return;
        }
        String roomId = message.getRoomId(); // Assuming SignalingMessage now has a roomId field
        log.info("Received join request from '{}' for room '{}'", username, roomId);

        // Find or create the room. Using computeIfAbsent for thread-safety.
        Set<String> roomUsers = rooms.computeIfAbsent(roomId, k -> ConcurrentHashMap.newKeySet());

        // Send the list of existing users in the room to the new user
        messagingTemplate.convertAndSend(String.format("/topic/rooms/%s", roomId),
                new SignalingMessage("server", username, "existing_users", roomUsers, roomId));

        // Add the new user to the room and track their session
        roomUsers.add(username);
        userRoomMap.put(username, roomId);
        headerAccessor.getSessionAttributes().put("username", username);
        headerAccessor.getSessionAttributes().put("roomId", roomId);

        // Announce the new user to all *other* users in the same room
        // The message type "new_user" tells clients to initiate a connection with this user
        // The sender in the message is now the authenticated user.
        SignalingMessage newUserMessage = new SignalingMessage(username, null, "new_user", null, roomId); 
        messagingTemplate.convertAndSend(String.format("/topic/rooms/%s", roomId), newUserMessage);
    }

    /**
     * Forwards a signaling message (like offer, answer, or ICE candidate) to a specific recipient
     * within a room.
     */
    @MessageMapping("/signal.forward")
    public void forward(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        // Get the authenticated sender's username from the session.
        String sender = headerAccessor != null && headerAccessor.getUser() != null
                ? headerAccessor.getUser().getName()
                : null;
        if (sender == null) {
            log.error("Cannot forward message from an unauthenticated user.");
            return;
        }
        String roomId = message.getRoomId();

        log.info("Forwarding message from '{}' in room '{}'", sender, roomId);

        // Forward the message (offer, answer, ICE candidate) to the room topic
        messagingTemplate.convertAndSend(String.format("/topic/rooms/%s", roomId), message);
    }

    @MessageMapping("/signal.leaveRoom")
    public void leaveRoom(@Payload SignalingMessage message, SimpMessageHeaderAccessor headerAccessor) {
        String username = headerAccessor.getUser().getName();
        String roomId = userRoomMap.get(username);

        if (username != null && roomId != null) {
            log.info("User '{}' leaving room '{}'", username, roomId);
            Set<String> roomUsers = rooms.get(roomId);
            if (roomUsers != null) {
                roomUsers.remove(username);
                userRoomMap.remove(username);
                // Announce that the user has left so clients can clean up their connections
                SignalingMessage leaveMessage = new SignalingMessage(username, null, "user_left", null, roomId);
                messagingTemplate.convertAndSend(String.format("/topic/rooms/%s", roomId), leaveMessage);

                // If the room is now empty, remove it to free up memory
                if (roomUsers.isEmpty()) {
                    rooms.remove(roomId);
                    log.info("Room '{}' is now empty and has been removed.", roomId);
                }
            }
        }
    }

    /**
     * Handles user disconnection events to gracefully remove them from rooms.
     */
    @EventListener
    public void handleSessionDisconnect(SessionDisconnectEvent event) {
        SimpMessageHeaderAccessor headers = SimpMessageHeaderAccessor.wrap(event.getMessage());
        // On disconnect, the user principal is available.
        String username = headers.getUser() != null ? headers.getUser().getName() : null;
        
        // We retrieve the roomId from our userRoomMap, which is more reliable.
        String roomId = userRoomMap.get(username);

        if (username != null && roomId != null) {
            log.info("User '{}' disconnected from room '{}'", username, roomId);
            Set<String> roomUsers = rooms.get(roomId);
            if (roomUsers != null) {
                roomUsers.remove(username);
                userRoomMap.remove(username);
                // Announce that the user has left so clients can clean up their connections
                SignalingMessage leaveMessage = new SignalingMessage(username, null, "user_left", null, roomId);
                messagingTemplate.convertAndSend(String.format("/topic/rooms/%s", roomId), leaveMessage);

                // If the room is now empty, remove it to free up memory
                if (roomUsers.isEmpty()) {
                    rooms.remove(roomId);
                    log.info("Room '{}' is now empty and has been removed.", roomId);
                }
            }
        }
    }

    private void broadcastToRoom(String roomId, String sender, SignalingMessage message) {
        rooms.getOrDefault(roomId, Set.of()).stream()
                .filter(user -> !user.equals(sender)) // Don't send to the sender
                .forEach(user -> messagingTemplate.convertAndSendToUser(user, "/queue/signals", message));
    }
}
