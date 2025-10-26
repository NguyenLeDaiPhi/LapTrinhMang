package com.audio.signalinghandler.dto;

import lombok.Data;

@Data
public class UserDTO {
    private String username;
    private String email;
    private String password;
    private String role;

    public String role() {
        return "USER";
    }
}
