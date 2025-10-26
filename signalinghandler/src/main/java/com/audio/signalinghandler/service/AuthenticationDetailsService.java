package com.audio.signalinghandler.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;

import com.audio.signalinghandler.model.User;
import com.audio.signalinghandler.model.UserPrinciple; // This was missing
import com.audio.signalinghandler.repository.UserRepository;

@Service

public class AuthenticationDetailsService implements UserDetailsService{
    
    @Autowired
    private UserRepository userRepository;

    @Override
    public UserDetails loadUserByUsername(String email) throws UsernameNotFoundException {
        User user = userRepository.findByEmail(email)
                .orElseThrow(() -> new UsernameNotFoundException("User not found with email: " + email));
        if (user == null) {
            throw new UsernameNotFoundException("Email not found, please try again.");
        }
        return new UserPrinciple(user);
    }
}