package bi.dx.dxblock;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** The daily filter refresh. */
public class UpdateJob extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(() -> {
            Updater.Result r = Updater.rebuild(getApplicationContext(), true);
            jobFinished(params, !r.failed.isEmpty());
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
