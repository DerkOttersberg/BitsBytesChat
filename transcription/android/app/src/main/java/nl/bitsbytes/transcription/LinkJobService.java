package nl.bitsbytes.transcription;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class LinkJobService extends JobService {
    @Override public boolean onStartJob(JobParameters parameters) {
        BitsApp app = (BitsApp) getApplication(); if (app.links == null) return false;
        app.links.flushAsync().whenComplete((pending, error) -> jobFinished(parameters, error != null || Boolean.TRUE.equals(pending))); return true;
    }
    @Override public boolean onStopJob(JobParameters parameters) { return true; }
}
