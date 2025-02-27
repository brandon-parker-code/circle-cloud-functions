/* eslint-disable max-len */
import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {onDocumentDeleted} from 'firebase-functions/v2/firestore';
import * as v2 from 'firebase-functions/v2';
import * as admin from 'firebase-admin';


type Indexable = {[key: string]: any };
initializeApp();
const db = getFirestore();

export const helloWorld = v2.https.onRequest((request, response) => {
    // debugger;
    const name = request.params[0];
    const items: Indexable = {
        lamp: 'This is a lamp',
        chair: 'Good chair',
    };
    const message = items[name];

    response.send(`<h1>${message}</h1>`);
});

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

        return await admin.messaging().send(message);
    }

    return null;
}

export const onCircleDeleted = onDocumentDeleted('circles/{circleId}', async (event) => {
    const circleId = event.params.circleId;
    const deletedData = event.data?.data();
    const userId = deletedData?.userId;

    console.log(`Document with ID ${circleId} was deleted.`);
    console.log('Deleted data:', deletedData);

    try {
        // Query all users to check if their 'circles' sub-collection has any document referencing the deleted circleId
        const usersSnapshot = await db.collection('users').get();

        // Use Promise.all to process all users and their sub-collection deletions asynchronously
        await Promise.all(usersSnapshot.docs.map(async (userDoc) => {
            // Check the 'circles' sub-collection for matching documents
            const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
            const circles2Snapshot = await circles2Ref.get();

            // Loop over the found 'circles' documents and delete them
            await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
                await circles2Doc.ref.delete();
                console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
            }));
        }));

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userId);
        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, 'Cicle Notification', 'Your circle has been deleted.');
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle deletion operation for circleId: ${circleId}`, error);
    }

    return null;
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
            const circles2Ref = userDoc.ref.collection('circles').where('circleId', '==', circleId);
            const circles2Snapshot = await circles2Ref.get();

            // Loop over the found 'circles' documents and delete them
            await Promise.all(circles2Snapshot.docs.map(async (circles2Doc) => {
                await circles2Doc.ref.delete();
                console.log(`Related 'users/circles' document with ID ${circles2Doc.id} deleted.`);
            }));
        }));

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(userId);

        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, 'Cicle Notification', 'You have been removed from circle.');
        }

        // Optional: Handle other tasks that may need to be done asynchronously
    } catch (error) {
        console.error(`Error during circle user deletion operation for circleId: ${circleId} userId: ${userId}`, error);
    }

    return null;
});
