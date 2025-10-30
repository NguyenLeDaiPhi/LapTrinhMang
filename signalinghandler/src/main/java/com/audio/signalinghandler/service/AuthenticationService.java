package com.audio.signalinghandler.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import com.audio.signalinghandler.dto.UserDTO;
import com.audio.signalinghandler.model.User;
import com.audio.signalinghandler.repository.UserRepository;

@Service
public class AuthenticationService {
    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthenticationDetailsService authDetailsService;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private JwtServiceUser jwtService;

    public User register(UserDTO userDTO) {
        if (userRepository.findByEmail(userDTO.getEmail()).isPresent()) {
            throw new IllegalArgumentException("Email " + userDTO.getEmail() + " is already registerd, please use another email.");
        }
        if (userRepository.findByUsername(userDTO.getUsername()).isPresent()) {
            throw new IllegalArgumentException("Username " + userDTO.getUsername() + " is already taken, please choose another one.");
        }

        User userRegister = new User();
        userRegister.setEmail(userDTO.getEmail());
        userRegister.setUsername(userDTO.getUsername());
        userRegister.setPassword(passwordEncoder.encode(userDTO.getPassword()));
        return userRepository.save(userRegister);
    }

    public String verify(UserDTO userDTO) {
        try {
            DaoAuthenticationProvider provider = new DaoAuthenticationProvider(authDetailsService);
            provider.setPasswordEncoder(passwordEncoder);

            AuthenticationManager authManager = new ProviderManager(provider);

            authManager.authenticate(new UsernamePasswordAuthenticationToken(userDTO.getUsername(), userDTO.getPassword()));

            return jwtService.generateToken(userDTO.getUsername());

        } catch (BadCredentialsException e) {
            return null;
        }
    }
}
