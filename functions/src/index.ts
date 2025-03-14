/* eslint-disable max-len */
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onDocumentCreated, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});
// Define the TypeScript interface for notifications
interface LocationNotification {
    title: string;
    body: string;
}

interface TripNotification {
    startTime: FirebaseFirestore.Timestamp;
    endTime: FirebaseFirestore.Timestamp;
    avgSpeed: number;
    maxSpeed: number;
    distance: number;
    duration: number;
}

interface Notification {
    id: string;
    userId: string;
    circleId: string;
    userName: string;
    tripNotification: TripNotification | undefined;
    locationNotification: LocationNotification | undefined;
    dateCreated: FirebaseFirestore.Timestamp;
}

/**
 * Gets the device token from the user document
 * @param {string} userId The userId field
 * @return {Promise<string> | null} The deviceToken or null
 */
async function getDeviceToken(userId: string): Promise<string | null> {
    try {
        const userQuerySnapshot = await db.collection('users').where('userId', '==', userId).get();

        if (userQuerySnapshot.empty) {
            console.warn(`No user found with userId: ${userId}`);
            return null;
        }

        const userDoc = userQuerySnapshot.docs[0]; // Assuming userId is unique
        const deviceToken = userDoc.data().deviceToken;

        console.log(`Found user document with ID: ${userDoc.id}`);
        console.log(`Device Token: ${deviceToken}`);

        return deviceToken || null;
    } catch (error) {
        console.error(`Error fetching device token for user ${userId}:`, error);
        return null;
    }
}

/**
 * Sends a Push Notification to the device
 * @param {string} deviceToken The users deviceToken
 * @param {string} title The notification title
 * @param {string} body The notification body
 * @return {Promise<string> | null} The deviceToken or null
 */
async function sendPushNotification(deviceToken: string, title: string, body: string) : Promise<string | null> {
    if (deviceToken) {
        const message = {
            token: deviceToken,
            notification: {
                title: title,
                body: body,
            },
        };

        console.log(message);
        return await admin.messaging().send(message);
    }

    return null;
}

/**
 * deletes and entire sub collection
 * @param {FirebaseFirestore.CollectionReference} collectionRef The collection reference
 */
async function deleteSubCollection(collectionRef: FirebaseFirestore.CollectionReference): Promise<void> {
    const snapshot = await collectionRef.get();
    await Promise.all(snapshot.docs.map(async (doc) => {
        await doc.ref.delete();
        console.log(`Deleted document ${doc.id} from sub-collection.`);
    }));

    Promise.resolve();
}

export const onCircleDeleted = onDocumentDeleted('circles/{circleId}', async (event) => {
    const circleId = event.params.circleId;
    const deletedData = event.data?.data();
    const userId = deletedData?.userId;
    const circleName = deletedData?.name;

    console.log(`Document with ID ${circleId} was deleted.`);
    console.log('Deleted data:', deletedData);

    try {
        // Delete 'users' sub-collection under the deleted 'circles' document
        const users1Ref = db.collection(`circles/${circleId}/users`);
        await deleteSubCollection(users1Ref);
        console.log(`All documents in 'users' sub-collection under circle ${circleId} deleted.`);

        // // Query all users to check if their 'circles' sub-collection has any document referencing the deleted circleId
        // const usersSnapshot = await db.collection('users').get();

        // // Use Promise.all to process all users and their sub-collection deletions asynchronously
        // await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
        //     // Check the 'circleIds' list for matching documents
        //     const userData = userDoc.data();
        //     const circleIds = userData.circleIds;
        //     const newCircleIds = circleIds.filter((i: string) => i !== circleId);

        //     console.log(`Updating circleIds to ${newCircleIds}`);
        //     userDoc.ref.update({circleIds: newCircleIds});

        //     //     const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
        //     //     const circles2Snapshot = await circles2Ref.get();

        // //     // Loop over the found 'circles' documents and delete them
        // //     await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
        // //         await circles2Doc.ref.delete();
        // //         console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
        // //     }));
        // }));

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userId);
        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, 'Circle Deleted', `Circle ${circleName} has been deleted.`);
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle deletion operation for circleId: ${circleId}`, error);
    }

    return Promise.resolve();
});

export const onCircleUserDeleted = onDocumentDeleted('circles/{circleId}/users/{userId}', async (event) => {
    const circleId = event.params.circleId;
    const userId = event.params.userId;
    const deletedData = event.data?.data();

    console.log(`Circle User document with circleId ${circleId} and userId ${userId} was deleted.`);
    console.log('Deleted data:', deletedData);

    try {
        // Query all users to check if their 'circles' sub-collection has any document referencing the deleted circleId
        const usersSnapshot = await db.collection('users').get();

        // Use Promise.all to process all users and their sub-collection deletions asynchronously
        await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
            // Check the 'circles' sub-collection for matching documents
            // const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
            // const circles2Snapshot = await circles2Ref.get();


            // Check the 'circleIds' list for matching documents
            const userData = userDoc.data();
            const circleIds = userData.circleIds;
            const newCircleIds = circleIds.filter((i: string) => i !== circleId);

            console.log(`User: ${userId} current circleIds ${circleIds} new circleIds ${newCircleIds}`);
            userDoc.ref.update({circleIds: newCircleIds});
            console.log(`User: ${userId} circleIds updated`);

            // // Loop over the found 'circles' documents and delete them
            // await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
            //     await circles2Doc.ref.delete();
            //     console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
            // }));
        }));

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userId);

        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, 'Removed from circle', 'You have been removed from a circle.');
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle user deletion operation for circleId: ${circleId} userId: ${userId}`, error);
    }

    return Promise.resolve();
});


export const onLocationEventCreated = onDocumentCreated('locationEvents/{id}', async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        console.log('No data associated with the event.');
        return;
    }

    const eventData = snapshot.data();
    const userId = eventData.userId;
    const userName = eventData.userName;
    const eventName = eventData.eventName;
    const state = eventData.state;
    const circleId = eventData.circleId;

    const id = event.params.id;
    console.log(`New location event created: ${id}`, eventData);
    // Perform additional operations, such as notifying users, logging, etc.

    // Reference the 'users' subcollection
    const usersCollectionRef = db.collection(`circles/${circleId}/users`);
    const usersSnapshot = await usersCollectionRef.get();

    if (usersSnapshot.empty) {
        console.log(`No users found in circle ${circleId}`);
        return;
    }

    // Process each user document asynchronously
    const userPromises = usersSnapshot.docs.map(async (doc) => {
        const userData = doc.data();

        // Get the user document where the userId matches
        // const deviceToken = await getDeviceToken(userId);
        console.log(`Processing user ${userData.id} in circle ${circleId}:`);
        const action = state == 'entered' ? 'arriving' : 'leaving';

        // Create notificaiton\message title and body
        const title = 'Location';
        const body = `${userName} is ${action} at ${eventName}.`;

        // Create a new document reference to get the ID before writing
        const notificationRef = db.collection(`users/${userData.id}/notifications`).doc();

        // Create a location notification object with strong typing
        const locationNotification: LocationNotification = {
            title: title,
            body: body,
        };

        // Create the notification object with strong typing
        const notificationData: Notification = {
            id: notificationRef.id, // Store the generated ID
            userId: userId, // userId for the user that generated the event
            circleId: circleId, // The circleId
            userName: userName, // userName for the ser that generated th even
            tripNotification: undefined, // set undefined
            locationNotification: locationNotification, // Message Title
            dateCreated: Timestamp.now(), // Firestore timestamp
        };

        // Insert into user's 'notifications' subcollection
        notificationRef.set(notificationData);

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userData.id);
        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, title, body);
        }

        // Example: Update user document (modify as needed)
        return doc.ref.update({processed: true});
    });

    // Wait for all updates to complete
    await Promise.all(userPromises);

    return Promise.resolve();
});

export const onTripCreated = onDocumentCreated('users/{userId}/trips/{tripId}', async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        console.log('No data associated with the event.');
        return;
    }
    const eventData = snapshot.data();
    const userId = event.params.userId;

    // Create a new document reference to get the ID before writing
    const notificationRef = db.collection(`users/${userId}/notifications`).doc();

    // Create a trip notification object with strong typing
    const tripNotification: TripNotification = {
        startTime: eventData.startTime,
        endTime: eventData.endTime,
        avgSpeed: eventData.avgSpeed,
        maxSpeed: eventData.maxSpeed,
        distance: eventData.distance,
        duration: eventData.duration,
    };

    // Create the notification object with strong typing
    const notificationData: Notification = {
        id: notificationRef.id, // Store the generated ID
        userId: userId, // userId for the user that generated the event
        circleId: 'circleId', // The circleId
        userName: eventData.name, // userName for the ser that generated th even
        tripNotification: tripNotification, // set undefined
        locationNotification: undefined, // Message Title
        dateCreated: Timestamp.now(), // Firestore timestamp
    };

    // Insert into user's 'notifications' subcollection
    notificationRef.set(notificationData);


    console.log(`Processing Notification Trip data for user ${userId}`);
    return Promise.resolve();
});
