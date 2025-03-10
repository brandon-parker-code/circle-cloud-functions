/* eslint-disable max-len */
import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {onDocumentCreated, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

initializeApp();
const db = getFirestore();

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

        // Query all users to check if their 'circles' sub-collection has any document referencing the deleted circleId
        // const usersSnapshot = await db.collection('users').get();

        // // Use Promise.all to process all users and their sub-collection deletions asynchronously
        // await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
        //     // Check the 'circles' sub-collection for matching documents
        //     const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
        //     const circles2Snapshot = await circles2Ref.get();

        //     // Loop over the found 'circles' documents and delete them
        //     await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
        //         await circles2Doc.ref.delete();
        //         console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
        //     }));
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
        // const usersSnapshot = await db.collection('users').get();

        // // Use Promise.all to process all users and their sub-collection deletions asynchronously
        // await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
        //     // Check the 'circles' sub-collection for matching documents
        //     const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
        //     const circles2Snapshot = await circles2Ref.get();

        //     // Loop over the found 'circles' documents and delete them
        //     await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
        //         await circles2Doc.ref.delete();
        //         console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
        //     }));
        // }));

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

    const id = event.params.id;
    console.log(`New location event created: ${id}`, eventData);
    // Perform additional operations, such as notifying users, logging, etc.

    // Get the user document where the userId matches
    const deviceToken = await getDeviceToken(userId);

    const action = state == 'entered' ? 'arriving' : 'leaving';
    // Send a notification to the user
    if (deviceToken) {
        await sendPushNotification(deviceToken, 'Location', `${userName} is ${action} at ${eventName}.`);
    }

    return Promise.resolve();
});
