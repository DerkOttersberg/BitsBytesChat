package nl.bitsbytes.transcription;

final class AppFailure extends Exception {
    final String code;
    AppFailure(String code) { super(code); this.code = code; }
}
