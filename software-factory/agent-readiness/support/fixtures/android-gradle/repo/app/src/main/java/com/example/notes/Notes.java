package com.example.notes;

public final class Notes {
  private Notes() {}

  public static String title(String body) {
    int end = body.indexOf('\n');
    return end < 0 ? body : body.substring(0, end);
  }
}
