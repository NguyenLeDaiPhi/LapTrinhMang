package com.audio.signalinghandler.controller;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

import com.audio.signalinghandler.model.UserPrinciple;
import com.audio.signalinghandler.dto.UserDTO;
import com.audio.signalinghandler.model.User;
import com.audio.signalinghandler.service.AuthenticationService;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;

@Controller
@RequestMapping("/user")
public class AuthenticationController {
    
    @Autowired
    private AuthenticationService authService;

    @GetMapping("/register")
    public String showRegisterForm(Model model) {
        model.addAttribute("user", new UserDTO());
        return "register";
    }

    @PostMapping("/register")
    public String registerUser(@ModelAttribute("user") UserDTO userDTO, Model model) {
        try {
            authService.register(userDTO);
            return "redirect:/user/login?registered";
        } catch (IllegalArgumentException e) {
            return "redirect:/user/register?error";
        }
    }

    @GetMapping("/login")
    public String showLoginForm(Model model) {
        model.addAttribute("user", new UserDTO());
        return "login";
    }

    @PostMapping("/login")
    public String handleLogin(@ModelAttribute("user") UserDTO userDTO, HttpServletResponse response) {
        String token = authService.verify(userDTO);

        if (token != null) {
            Cookie cookie = new Cookie("jwt-token-user", token);
            // Set HttpOnly to false so that client-side JavaScript can read it.
            // This is necessary for the WebSocket connection header.
            cookie.setHttpOnly(false);
            cookie.setPath("/");
            response.addCookie(cookie);
            return "redirect:/user/index";
        } else {
            return "redirect:/user/login?error";
        }
    }

    @PostMapping("/logout")
    public String logout(HttpServletResponse response) {
        // Create a cookie that expires immediately to clear the existing one
        Cookie cookie = new Cookie("jwt-token-user", null);
        cookie.setHttpOnly(true);
        cookie.setPath("/");
        cookie.setMaxAge(0); // This effectively deletes the cookie
        response.addCookie(cookie);
        return "redirect:/user/login?logout";
    }

    @GetMapping("/index")
    public String indexForm(Model model, @AuthenticationPrincipal UserPrinciple userPrinciple) {
        if (userPrinciple != null) {
            // Pass the actual username to the view
            model.addAttribute("username", userPrinciple.getRealUsername());
        }
        return "index";
    }
}
