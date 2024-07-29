import NotificationsService from "./services/Notification/Service";
import Service from "./services/Agent/Service";
import { NotificationsHandler } from "./services/Notification/Service";

const pushService = new NotificationsService(new NotificationsHandler());
const agentService = new Service();

const run = async () => {
  const agent = await agentService.startAgent();
  await agent.initialize();
  await agentService.handleSocketsUpgrade();
  await pushService.setupPushNotificationsObserver(agent);
  await agentService.logMediaitonInvitation();
};

void run();
