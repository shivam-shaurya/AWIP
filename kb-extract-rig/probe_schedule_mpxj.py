#!/usr/bin/env python3
r"""
probe_schedule_mpxj.py - run ONCE on the server (needs the JVM + the `mpxj` package) against a real
.xer / .mpp / P6-XML / MSP-XML file. It answers the two P0/P1 questions in one shot:

  (1) P0 - do the MPXJ calls schedule_mpxj.py RELIES ON actually work on your installed MPXJ?
           (each prints OK + a sample value, or FAIL + the error - any FAIL is a parser bug to fix.)
  (2) P1 - what are the EXACT method names for the not-yet-built features (resources, assignments,
           costs, calendars/working-time, P6 activity codes, Data Date, multi-project)? It probes the
           likely names AND dumps every get*/list* method on Task / Resource / Assignment / Project /
           ProjectProperties / ProjectCalendar so we can name the P1 extraction calls correctly.

Usage:
  python probe_schedule_mpxj.py "C:\path\to\schedule.xer"
Paste the whole output back and we (a) lock any P0 API fixes and (b) write P1 against the real names.
"""
import sys


def _try(label, fn):
    """Call fn(), print OK + a short sample value, or FAIL + the error. Never raises."""
    try:
        v = fn()
        s = "None" if v is None else str(v)
        print("  OK   %-36s = %s" % (label, (s[:72] + "…") if len(s) > 72 else s))
        return v
    except Exception as e:
        print("  FAIL %-36s : %s: %s" % (label, type(e).__name__, str(e)[:70]))
        return None


def _methods(obj):
    """Sorted get*/list*/has* method names available on a Java object (what MPXJ actually exposes)."""
    try:
        return sorted({m for m in dir(obj) if m.startswith(("get", "list", "has"))})
    except Exception:
        return []


def main():
    if len(sys.argv) < 2:
        print("usage: python probe_schedule_mpxj.py <schedule file (.xer/.mpp/.xml)>")
        return
    path = sys.argv[1]
    try:
        from mpxj import startJVM, isJVMStarted, JClass
    except Exception as e:
        print("Cannot import `mpxj`:", e, "\nInstall it (see requirements-schedule.txt) on the JVM box.")
        return
    if not isJVMStarted():
        startJVM()

    print("Reading:", path)
    reader = JClass("org.mpxj.reader.UniversalProjectReader")()
    project = reader.read(path)
    if project is None:
        print("MPXJ returned no project - unsupported/corrupt, or the namespace/format wasn't recognised.")
        return
    props = project.getProjectProperties()

    print("\n=== PROJECT / PROPERTIES  (metadata + the Data Date P1 needs) ===")
    _try("props.getName", props.getName)
    _try("props.getProjectTitle", props.getProjectTitle)
    _try("props.getStartDate", props.getStartDate)
    _try("props.getFinishDate", props.getFinishDate)
    _try("props.getStatusDate  (= Data Date)", props.getStatusDate)
    _try("props.getCurrentDate", props.getCurrentDate)
    _try("props.getDefaultCalendar().getName()", lambda: props.getDefaultCalendar().getName())
    _try("project.getResources().size", lambda: project.getResources().size())
    _try("project.getResourceAssignments().size", lambda: project.getResourceAssignments().size())
    _try("project.getCalendars().size", lambda: project.getCalendars().size())
    _try("project.getCustomFields", project.getCustomFields)
    _try("project.getActivityCodes  (P6 codes)", lambda: project.getActivityCodes())
    _try("project.getProjects  (multi-project XER)", lambda: project.getProjects())

    tasks = [t for t in project.getTasks() if t.getID() is not None and int(t.getID()) != 0]
    print("\nreal tasks:", len(tasks))
    if tasks:
        t = next((x for x in tasks if not bool(x.getSummary())), tasks[0])   # prefer a leaf task
        print("\n=== TASK calls the PARSER USES  (every one must be OK) ===")
        for label, fn in [
            ("getActivityID", t.getActivityID), ("getName", t.getName), ("getWBS", t.getWBS),
            ("getStart", t.getStart), ("getFinish", t.getFinish),
            ("getActualStart", t.getActualStart), ("getActualFinish", t.getActualFinish),
            ("getDuration", t.getDuration), ("getRemainingDuration", t.getRemainingDuration),
            ("getPercentageComplete", t.getPercentageComplete),
            ("getPercentageWorkComplete", t.getPercentageWorkComplete),
            ("getEarlyStart", t.getEarlyStart), ("getLateFinish", t.getLateFinish),
            ("getTotalSlack", t.getTotalSlack), ("getFreeSlack", t.getFreeSlack),
            ("getCritical", t.getCritical), ("getSummary", t.getSummary), ("getMilestone", t.getMilestone),
            ("getBaselineStart()", t.getBaselineStart), ("getBaselineFinish()", t.getBaselineFinish),
            ("getBaselineStart(1)", lambda: t.getBaselineStart(1)),
            ("getBaselineDuration(1)", lambda: t.getBaselineDuration(1)),
            ("getStartVariance", t.getStartVariance), ("getFinishVariance", t.getFinishVariance),
            ("getConstraintType", t.getConstraintType), ("getConstraintDate", t.getConstraintDate),
            ("getCalendar", t.getCalendar), ("getPriority", t.getPriority),
            ("getOutlineLevel", t.getOutlineLevel), ("getOutlineNumber", t.getOutlineNumber),
            ("getParentTask", t.getParentTask), ("getPredecessors", t.getPredecessors),
            ("getText(1)", lambda: t.getText(1)), ("getNumber(1)", lambda: t.getNumber(1)),
        ]:
            _try(label, fn)

        print("\n=== TASK calls P1 WILL NEED  (name discovery: resources / cost / codes / type) ===")
        for label, fn in [
            ("getResourceAssignments", t.getResourceAssignments),
            ("getCost", t.getCost), ("getBaselineCost", t.getBaselineCost),
            ("getActualCost", t.getActualCost), ("getFixedCost", t.getFixedCost),
            ("getWork", t.getWork), ("getBaselineWork", t.getBaselineWork),
            ("getActualWork", t.getActualWork), ("getRemainingCost", t.getRemainingCost),
            ("getActivityType", lambda: t.getActivityType()),
            ("getActivityCodeValues", lambda: t.getActivityCodeValues()),
        ]:
            _try(label, fn)

        print("\n=== all get*/list* available on a TASK ===")
        print("   " + ", ".join(_methods(t)))

        # find ANY task that HAS predecessors (the first leaf is usually the project
        # start with none, so scan the whole list) - this is the #1 accessor to verify.
        rel = None
        n_with_preds = 0
        for x in tasks:
            try:
                preds = list(x.getPredecessors())
            except Exception:
                preds = []
            if preds:
                n_with_preds += 1
                if rel is None:
                    rel = preds[0]
        print("\n=== RELATION (predecessor) methods  [THE #1 THING TO VERIFY] ===")
        print("  tasks with >=1 predecessor: %d / %d" % (n_with_preds, len(tasks)))
        if rel is None:
            print("  (no task has predecessors -> MPXJ read ZERO logic links: investigate the reader)")
        else:
            _try("getPredecessorTask", lambda: rel.getPredecessorTask())
            _try("getSuccessorTask", lambda: rel.getSuccessorTask())
            _try("getSourceTask (likely-correct name)", lambda: rel.getSourceTask())
            _try("getTargetTask (likely-correct name)", lambda: rel.getTargetTask())
            _try("getType", lambda: rel.getType())
            _try("getLag", lambda: rel.getLag())
            print("   all get* on a Relation object: " + ", ".join(_methods(rel)))

    res = list(project.getResources())
    if res:
        r = res[0]
        print("\n=== RESOURCE [0]  (P1: resources) ===")
        for label, fn in [("getName", r.getName), ("getResourceID", lambda: r.getResourceID()),
                          ("getType", lambda: r.getType()), ("getStandardRate", lambda: r.getStandardRate()),
                          ("getCost", lambda: r.getCost()), ("getMaxUnits", lambda: r.getMaxUnits())]:
            _try(label, fn)
        print("   all get*: " + ", ".join(_methods(r)))

    asn = list(project.getResourceAssignments())
    if asn:
        a = asn[0]
        print("\n=== RESOURCE ASSIGNMENT [0]  (P1: assignments - cost/work loading) ===")
        for label, fn in [("getResource", lambda: a.getResource()), ("getTask", lambda: a.getTask()),
                          ("getUnits", lambda: a.getUnits()), ("getWork", lambda: a.getWork()),
                          ("getCost", lambda: a.getCost()), ("getActualCost", lambda: a.getActualCost())]:
            _try(label, fn)
        print("   all get*: " + ", ".join(_methods(a)))

    cals = list(project.getCalendars())
    if cals:
        c = cals[0]
        print("\n=== CALENDAR [0]  (P1: working-time / holidays / exceptions) ===")
        print("   all get*: " + ", ".join(_methods(c)))

    print("\n=== ProjectProperties methods (for the metadata gaps) ===")
    print("   " + ", ".join(_methods(props)))
    print("\nDone. Paste this whole output back: any FAIL above is a P0 fix, and the method dumps tell us"
          "\nexactly how to name the P1 resource/cost/calendar/activity-code extraction.")


if __name__ == "__main__":
    main()
