package com.audio.signalinghandler.config;

import com.audio.signalinghandler.service.AuthenticationDetailsService;
import com.audio.signalinghandler.service.JwtServiceUser;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class AuthChannelInterceptor implements ChannelInterceptor {

    @Autowired
    private JwtServiceUser jwtService;

    @Autowired
    private AuthenticationDetailsService userDetailsService;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);

        if (StompCommand.CONNECT.equals(accessor.getCommand())) {
            List<String> authorization = accessor.getNativeHeader("Authorization");

            String authHeader = (authorization != null && !authorization.isEmpty()) ? authorization.get(0) : null;
            if (authHeader != null && authHeader.startsWith("Bearer ")) {
                String jwt = authHeader.substring(7);
                String username = jwtService.extractUsername(jwt);

                if (username != null) {
                    UserDetails userDetails = this.userDetailsService.loadUserByUsername(username);
                    if (jwtService.validateToken(jwt, userDetails)) {
                        // The Principal object for the WebSocket session MUST be the one that SimpUserRegistry uses.
                        // Our UserPrinciple now implements Principal and has a getName() method.
                        UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                                userDetails, null, userDetails.getAuthorities());
                        // This is the key step that links the username to the session ID.
                        accessor.setUser(authentication);
                    }
                }
            }
        }
        return message;
    }
}