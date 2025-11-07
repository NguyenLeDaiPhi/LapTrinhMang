package com.audio.signalinghandler.service;

import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

import javax.crypto.SecretKey;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Service;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;

@Service
public class JwtServiceUser {
    // The key needs to be at least 256 bits (32 bytes) for HS256.
    // The previous key was being decoded incorrectly and was too short.
    // Moved to application.properties for better security and management.
    @Value("${jwt.secret}")
    private String secret;

    public SecretKey getKey() {
        byte[] keyBytes = Decoders.BASE64.decode(secret);
        return Keys.hmacShaKeyFor(keyBytes); 
    }

    public String generateToken(String username) {
        Map<String, Object> claims = new HashMap<>();
            return Jwts.builder()
                    .claims(claims)
                    .subject(username)
                    .issuedAt(new Date(System.currentTimeMillis()))
                    .expiration(new Date(System.currentTimeMillis() + 1000 * 60 * 60 * 24))
                    .signWith(getKey())
                    .compact();

    }

    public String extractUsername(String token) {
        // Extract the subject (username) from the jwt token
        return extractClaim(token, Claims::getSubject);
    }

    private <T> T extractClaim(String token, Function<Claims, T> claimResolver) {
        final Claims claims = extractAllClaims(token);
        return claimResolver.apply(claims);
    }

    // This method is updated for modern jjwt versions (0.12.0+)
    private Claims extractAllClaims(String token) {
        return Jwts.parser() // The new builder-style parser
                .verifyWith(getKey()) // Use verifyWith(SecretKey) instead of setSigningKey
                .build()
                .parseSignedClaims(token) // Use parseSignedClaims(token) instead of parseClaimsJws
                .getPayload(); // Use getPayload() instead of getBody()
    }

    public boolean validateToken(String token, UserDetails userDetails) {
        final String username = extractUsername(token);
        return username.equals(userDetails.getUsername()) && !isTokenExpired(token);
    }

    private boolean isTokenExpired(String token) {
        return extractExpiration(token).before(new Date());
    }

    private Date extractExpiration(String token) {
        return extractClaim(token, Claims::getExpiration);
    }
}
