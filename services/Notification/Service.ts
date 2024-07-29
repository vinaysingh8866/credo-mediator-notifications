import {
  Agent,
  AgentEventTypes,
  AgentMessageProcessedEvent,
  ConnectionRepository,
  ForwardMessage,
} from "@credo-ts/core";
import { MediationRepository } from "@credo-ts/core/build/modules/routing/repository/MediationRepository";
import { PushNotificationsFcmSetDeviceInfoMessage } from "@credo-ts/push-notifications";
import * as process from "node:process";
import { base64Decode } from "@firebase/util";
import admin, { app } from "firebase-admin";
import App = app.App;
const serviceAcc = process.env.SERVICE_ACCOUNT;
const account = serviceAcc ? base64Decode(serviceAcc) : undefined;
if (!account) {
  throw new Error(
    "SERVICE_ACCOUNT environment variable is not set. Please add the account configuration."
  );
}

const PushNotificationKey = "pushNotificationMetadata";

type PushNotificationMetadata = {
  deviceToken: string;
  devicePlatform: "ios" | "android";
};

export default class NotificationsService {
  constructor(private pushNotificationHandler: NotificationsHandlerInterface) {}

  private log(agent: Agent, level: "debug" | "error", message: string): void {
    const { logger } = agent.context.config;
    level === "error" ? logger.error(message) : logger.debug(message);
  }

  private async processForwardMessage(
    agent: Agent,
    forwardMessage: ForwardMessage
  ): Promise<void> {
    const mediationRepository =
      agent.dependencyManager.resolve<MediationRepository>(MediationRepository);
    const mediationRecord = await mediationRepository.getSingleByRecipientKey(
      agent.context,
      forwardMessage.to
    );
    const conn = await agent.connections.findById(mediationRecord.connectionId);

    if (!conn?.isReady || !mediationRecord.isReady) {
      this.log(
        agent,
        "error",
        `Neither connection nor mediation record is ready for connection ID: ${conn?.id}`
      );
      return;
    }

    this.log(agent, "debug", `Delivering message to connection ID: ${conn.id}`);
    const pushNotificationMetadata = conn.metadata.get(
      PushNotificationKey
    ) as PushNotificationMetadata | null;

    if (pushNotificationMetadata) {
      try {
        await this.pushNotificationHandler.sendNotification(
          pushNotificationMetadata.deviceToken,
          {
            message: `You have a new message from ${conn.theirLabel}`,
            title: "New Message Notification",
          }
        );
        this.log(
          agent,
          "debug",
          `Push notification sent successfully to connection ID: ${conn.id}`
        );
      } catch (error) {
        this.log(
          agent,
          "error",
          `Failed to send push notification to connection ID: ${conn.id}`
        );
      }
    }
  }

  private async processSetTokenMessage(
    agent: Agent,
    setPushTokenMessage: PushNotificationsFcmSetDeviceInfoMessage,
    connectionId?: string
  ): Promise<void> {
    if (!connectionId) return;

    const connectionRepository =
      agent.dependencyManager.resolve<ConnectionRepository>(
        ConnectionRepository
      );
    const conn = await agent.connections.findById(connectionId);
    if (!conn) {
      this.log(agent, "error", `No connection found with ID: ${connectionId}`);
      return;
    }

    if (setPushTokenMessage.deviceToken && setPushTokenMessage.devicePlatform) {
      conn.metadata.set(PushNotificationKey, {
        deviceToken: setPushTokenMessage.deviceToken,
        devicePlatform: setPushTokenMessage.devicePlatform,
      });
      await connectionRepository.update(agent.context, conn);
    } else {
      conn.metadata.delete(PushNotificationKey);
      await connectionRepository.update(agent.context, conn);
    }
  }

  async setupPushNotificationsObserver(agent: Agent): Promise<void> {
    this.log(agent, "debug", "Initializing Push Notifications Observer...");

    agent.events.on(
      AgentEventTypes.AgentMessageProcessed,
      async (data: AgentMessageProcessedEvent) => {
        const { message } = data.payload;
        if (message.type === ForwardMessage.type.messageTypeUri) {
          await this.processForwardMessage(agent, message as ForwardMessage);
          this.log(
            agent,
            "debug",
            `Processed forward message with ID: ${message.id}`
          );
        }
        if (
          message.type ===
          PushNotificationsFcmSetDeviceInfoMessage.type.messageTypeUri
        ) {
          await this.processSetTokenMessage(
            agent,
            message as PushNotificationsFcmSetDeviceInfoMessage,
            data.payload.connection?.id
          );
          this.log(
            agent,
            "debug",
            `Processed device info message with ID: ${message.id}`
          );
        }
      }
    );
  }
}

export class NotificationsHandler implements NotificationsHandlerInterface {
  private firebaseAdmin: App;
  constructor() {
    const accountJson = JSON.parse(account as string);
    this.firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert(accountJson),
    });
  }

  async sendNotification(
    token: string,
    notification: PushNotificationMessage
  ): Promise<void> {
    const message = {
      data: notification.data,
      notification: {
        title: notification.title,
        body: notification.message,
      },
      token,
    };

    try {
      await admin.messaging().send(message);
    } catch (error) {
      console.error("Failed to send notification:", error);
    }
  }
}

export interface PushNotificationMessage {
  data?: Record<string, string>;
  message: string;
  title: string;
}

export interface NotificationsHandlerInterface {
  sendNotification(
    token: string,
    notification: PushNotificationMessage
  ): Promise<void>;
}
