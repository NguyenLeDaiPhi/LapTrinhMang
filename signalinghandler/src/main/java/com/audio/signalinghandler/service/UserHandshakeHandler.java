package com.audio.signalinghandler.service;

import org.springframework.http.server.ServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;

import java.security.Principal;
import java.util.Map;

public class UserHandshakeHandler extends DefaultHandshakeHandler {
    /**
     * This method is overridden to allow the default Spring mechanism to work.
     * For STOMP over WebSocket, Spring Security automatically creates the User Principal
     * from the 'user-name' header in the STOMP CONNECT frame. By calling super.determineUser,
     * we ensure this default behavior is preserved.
     */
    @Override
    protected Principal determineUser(ServerHttpRequest request, WebSocketHandler wsHandler, Map<String, Object> attributes) {
        // Let Spring handle user determination from the STOMP CONNECT frame's 'user-name' header.
        return super.determineUser(request, wsHandler, attributes);
    }
}
