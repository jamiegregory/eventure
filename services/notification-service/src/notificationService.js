export class NotificationService {
  constructor() {
    this.messages = [];
  }

  notifyScheduleChange({ attendeeIds = [], speakerIds = [], scheduleId, changeType }) {
    const attendeeMessages = attendeeIds.map((attendeeId) => ({
      recipientType: "attendee",
      recipientId: attendeeId,
      scheduleId,
      changeType
    }));

    const speakerMessages = speakerIds.map((speakerId) => ({
      recipientType: "speaker",
      recipientId: speakerId,
      scheduleId,
      changeType
    }));

    const messages = [...attendeeMessages, ...speakerMessages];
    this.messages.push(...messages);
    return messages;
  }

  allMessages() {
    return [...this.messages];
  }
}
