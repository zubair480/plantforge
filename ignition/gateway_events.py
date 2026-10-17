# Ignition gateway scripts (Jython 2.7) that push Pump 101 events to the cloud.
# The cloud never connects to the plant: Ignition sends outbound HTTPS only.
#
# Setup in the Ignition Designer:
# 1. Project Library: create script module "maintenance" and paste this whole file.
# 2. Set PLANT_INGEST_TOKEN below (from .env.local). Keep the project private.
# 3. Alarm pipeline or tag event: on Pump101/Fault (or the low-flow alarm),
#      Tag Change script:  maintenance.onFaultChange(currentValue.value)
# 4. Gateway Events > Timer (every 5000 ms, fixed delay):
#      maintenance.sendReading()
#
# Tag paths match public.assets.scada_tags for PUMP-101. Change them here if yours differ.

INGEST_URL = "https://nden3esm.us-west.insforge.app/functions/plant-ingest"
PLANT_INGEST_TOKEN = "PASTE_PLANT_INGEST_TOKEN"

ASSET_ID = "PUMP-101"
ALARM_ID = "PUMP101_LOW_FLOW"
TAGS = {
    "flow": "[default]Pump101/Flow",
    "run_cmd": "[default]Pump101/RunCmd",
    "fault": "[default]Pump101/Fault",
}

logger = system.util.getLogger("maintenance")
client = system.net.httpClient(timeout=10000)


def readTags():
    paths = [TAGS["flow"], TAGS["run_cmd"], TAGS["fault"]]
    values = system.tag.readBlocking(paths)
    return {
        "flow": float(values[0].value or 0),
        "run_cmd": bool(values[1].value),
        "fault": bool(values[2].value),
    }


def post(event):
    event["asset_id"] = ASSET_ID
    event["ts"] = system.date.format(system.date.now(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
    try:
        res = client.post(
            INGEST_URL,
            data=system.util.jsonEncode(event),
            headers={"Content-Type": "application/json", "x-plant-token": PLANT_INGEST_TOKEN},
        )
        if res.statusCode >= 300:
            logger.warn("ingest %s -> %s %s" % (event["type"], res.statusCode, res.text))
        return res
    except Exception as e:
        logger.error("ingest failed: %s" % e)


def onFaultChange(faultActive):
    tags = readTags()
    if faultActive:
        post({
            "type": "alarm_active",
            "alarm_id": ALARM_ID,
            "severity": "high",
            "message": "Pump 101 low flow: commanded to run, flow %s L/min, drive fault active" % tags["flow"],
            "tags": tags,
        })
    else:
        post({"type": "alarm_cleared", "alarm_id": ALARM_ID, "tags": tags})


def sendReading():
    post({"type": "reading", "tags": readTags()})
