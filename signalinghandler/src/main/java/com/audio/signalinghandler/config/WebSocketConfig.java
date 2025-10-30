package com.audio.signalinghandler.config;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Autowired
    private AuthChannelInterceptor authChannelInterceptor;


    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        // Destination prefix for ougoing message (Server -> Client)
        config.enableSimpleBroker("/topic", "/queue");
        // Destination prefix for incomming message (Client -> Server)
        config.setApplicationDestinationPrefixes("/app");
        // Prefix for sending a message to specific client
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // The endpoint client can connect to (e.g., for initial HTTP handshake)
        // Ensure to allow CORS if frontend is on different port/domain
        // Using setAllowedOriginPatterns("*") is recommended for SockJS to handle
        // various fallback mechanisms across different origins correctly.
        registry.addEndpoint("/ws").setAllowedOriginPatterns("*").withSockJS();
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(authChannelInterceptor);
    }
}