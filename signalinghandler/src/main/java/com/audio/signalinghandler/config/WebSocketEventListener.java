package com.audio.signalinghandler.config;

import com.audio.signalinghandler.controller.SignalingController;
import com.audio.signalinghandler.model.SignalingMessage;
import com.audio.signalinghandler.model.SignalType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessageSendingOperations;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.util.Set;

@Component
@RequiredArgsConstructor
@Slf4j
public class WebSocketEventListener {

    private final SimpMessageSendingOperations messagingTemplate;

    // This is a temporary solution. In a real app, use a distributed cache like Redis.
    private final Set<String> activeUsers = SignalingController.getActiveUsers();

    @EventListener
    public void handleWebSocketDisconnectListener(SessionDisconnectEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        String username = (String) headerAccessor.getSessionAttributes().get("username");

        if (username != null) {
            log.info("User disconnected: {}", username);

            var leaveMessage = SignalingMessage.builder()
                    .type(SignalType.LEAVE)
                    .sender(username)
                    .build();

            messagingTemplate.convertAndSend("/topic/public", leaveMessage);

            activeUsers.remove(username);
        }
    }
}