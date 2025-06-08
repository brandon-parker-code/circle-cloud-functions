/* eslint-disable max-len */
// import * as functions from 'firebase-functions';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onDocumentCreated, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
// import {onCustomEventPublished} from "firebase-functions/v2/eventarc";
import * as admin from 'firebase-admin';
// import {getStorage} from 'firebase-admin/storage';

initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});
// Define the TypeScript interface for notifications
interface LocationNotification {
    title: string;
    body: string;
    address: string;
    state: string;
    eventName: string;
}

interface TrackNotification {
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
    trackNotification: TrackNotification | undefined;
    locationNotification: LocationNotification | undefined;
    dateCreated: FirebaseFirestore.Timestamp;
}

interface CircleUser {
    id: string;
    role: string;
    authorization: string;
}

interface Circle {
    id: string;
    name: string;
    ownerId: string;
    dateCreated: Timestamp;
    users: [CircleUser] | undefined
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
 * Sends a Silent Push Notification to the device
 * @param {string} deviceToken The users deviceToken
 * @param {string} content data content
 * @return {Promise<string> | null} The deviceToken or null
 */
async function sendSilentPushNotification(deviceToken: string, content: string): Promise<string | null> {
    if (deviceToken) {
        const message = {
            token: deviceToken,
            apns: {
                headers: {
                    'apns-push-type': 'background',
                    'apns-topic': 'bp.circles',
                    'apns-priority': '5', // Background priority
                    'content-type': 'application/json',
                },
                payload: {
                    aps: {
                        'content-available': 1, // Required for silent push
                    },
                },
            },
        };

        console.log(JSON.stringify(message, null, 2));
        return await admin.messaging().send(message);
    }
    return null;
}

/**
 * deletes and entire sub collection
 * @param {FirebaseFirestore.CollectionReference} collectionRef The collection reference
 */
async function deleteSubCollection(collectionRef: admin.firestore.CollectionReference): Promise<void> {
    const snapshot = await collectionRef.get();
    await Promise.all(snapshot.docs.map(async (doc: admin.firestore.QueryDocumentSnapshot) => {
        await doc.ref.delete();
        console.log(`Deleted document ${doc.id} from sub-collection.`);
    }));

    Promise.resolve();
}

/**
 * Calculates the distance between two points on Earth using the Haversine formula
 * @param {number} lat1 Latitude of the first point in degrees
 * @param {number} lon1 Longitude of the first point in degrees
 * @param {number} lat2 Latitude of the second point in degrees
 * @param {number} lon2 Longitude of the second point in degrees
 * @return {number} Distance between the points in kilometers
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in kilometers
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
    // const userId = eventData.userId;
    const userName = eventData.userName;
    const eventName = eventData.eventName;
    const state = eventData.state;
    const circleId = eventData.circleId;
    const address = eventData.address;


    const id = event.params.id;
    console.log(`New location event created: ${id}`, eventData);
    // Perform additional operations, such as notifying users, logging, etc.

    // Reference the 'users' subcollection
    const circleCollectionRef = db.collection('circles').doc(`${circleId}`);
    const circleSnapshot = await circleCollectionRef.get();

    if (!circleSnapshot.exists) {
        console.log(`No circle found ${circleId}`);
        return;
    }

    const data = circleSnapshot.data();
    if (!data) {
        console.error('Data is undefined or null.');
        return null;
    }

    // Convert Firestore Timestamp to JavaScript Date
    const circle: Circle = {
        id: circleSnapshot.id,
        name: data.name || '', // Ensure name is a string
        ownerId: data.ownerId || '', // Ensure ownerId is a string
        dateCreated: data.dateCreated, // Handle Timestamp conversion
        users: data.users.map((user: CircleUser) => ({
            id: user.id || '', // Ensure id is a string
            role: user.role || '', // Ensure role is a string
            authorization: user.authorization || '', // Ensure authorization is a string
        })),
    };


    console.log(circle);

    if (!circle.users) {
        console.error('No user data.');
        return null;
    }

    // Process each user document asynchronously
    const userPromises = circle.users.map(async (user) => {
        // Get the user document where the userId matches
        // const deviceToken = await getDeviceToken(user.id);
        console.log(`Processing user ${user.id} in circle ${circle.id}:`);
        const action = state == 'arrived' ? 'arriving' : 'leaving';

        // Create notificaiton\message title and body
        const title = 'Location';
        const body = state == 'arrived' ? `${userName} is ${action} at ${eventName}.` : `${userName} is ${action} ${eventName}.`;

        // Create a new document reference to get the ID before writing
        const notificationRef = db.collection(`users/${user.id}/notifications`).doc();

        // Create a location notification object with strong typing
        const locationNotification: LocationNotification = {
            title: title,
            body: body,
            address: address,
            state: state,
            eventName: eventName,
        };

        // Create the notification object with strong typing
        const notificationData: Notification = {
            id: notificationRef.id, // Store the generated ID
            userId: user.id, // userId for the user that generated the event
            circleId: circleId, // The circleId
            userName: userName, // userName for the ser that generated th even
            trackNotification: undefined, // set undefined
            locationNotification: locationNotification, // Message Title
            dateCreated: Timestamp.now(), // Firestore timestamp
        };

        // Insert into user's 'notifications' subcollection
        notificationRef.set(notificationData);

        // Get the user document where the userId matches
        const deviceToken = await getDeviceToken(user.id);
        // Send a notification to the user
        if (deviceToken) {
            await sendPushNotification(deviceToken, title, body);
        }

        return Promise.resolve();
    });

    // Wait for all updates to complete
    await Promise.all(userPromises);

    return Promise.resolve();
});

export const onTrackCreated = onDocumentCreated('users/{userId}/tracks/{trackId}', async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        console.log('No data associated with the event.');
        return;
    }
    const eventData = snapshot.data();
    const userId = event.params.userId;

    // Create a new document reference to get the ID before writing
    const notificationRef = db.collection(`users/${userId}/notifications`).doc();

    // Create a track notification object with strong typing
    const trackNotification: TrackNotification = {
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
        trackNotification: trackNotification, // set undefined
        locationNotification: undefined, // Message Title
        dateCreated: Timestamp.now(), // Firestore timestamp
    };

    // Insert into user's 'notifications' subcollection
    notificationRef.set(notificationData);


    console.log(`Processing Notification Track data for user ${userId}`);
    return Promise.resolve();
});

export const onLiveTrackDeleted = onDocumentDeleted('users/{userId}/liveTracks/{trackId}', async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const deletedData = event.data?.data();

    console.log(`[User: ${userId}] LiveTrack document with ID ${trackId} was deleted`);
    console.log(`[User: ${userId}] Deleted data:`, deletedData);

    try {
        // Get all locations before deletion
        const locationsRef = db.collection(`users/${userId}/liveTracks/${trackId}/locations`);
        const locationsSnapshot = await locationsRef.get();
        if (!locationsSnapshot.empty) {
            let totalSpeed = 0;
            let maxSpeed = 0;
            let startTime: Timestamp | null = null;
            let endTime: Timestamp | null = null;
            let locationCount = 0;
            let totalDistance = 0;
            let prevLat: number | null = null;
            let prevLon: number | null = null;
            const breadcrumbs: any[] = [];

            // Process all locations in order
            await Promise.all(locationsSnapshot.docs.map(async (doc) => {
                const locationData = doc.data();
                const speed = locationData.speed || 0;
                const timestamp = locationData.timestamp as Timestamp;
                const latitude = locationData.latitude;
                const longitude = locationData.longitude;

                if (!(timestamp instanceof Timestamp)) {
                    console.error(`[User: ${userId}] Invalid timestamp format in location document`);
                    return;
                }

                // Calculate distance if we have previous coordinates
                if (prevLat !== null && prevLon !== null && latitude && longitude) {
                    totalDistance += calculateDistance(prevLat, prevLon, latitude, longitude);
                }
                prevLat = latitude;
                prevLon = longitude;

                // Update metrics
                totalSpeed += speed;
                maxSpeed = Math.max(maxSpeed, speed);
                locationCount++;

                // Update start and end times
                const timestampMillis = timestamp.toMillis();
                if (!startTime || timestampMillis < startTime.toMillis()) {
                    startTime = timestamp;
                }
                if (!endTime || timestampMillis > endTime.toMillis()) {
                    endTime = timestamp;
                }

                // Add location data to breadcrumbs array
                breadcrumbs.push({
                    ...locationData,
                });
            }));

            // Calculate final metrics
            const avgSpeed = locationCount > 0 ? totalSpeed / locationCount : 0;
            const duration = startTime && endTime ?
                Math.floor(((endTime as Timestamp).toMillis() - (startTime as Timestamp).toMillis()) / 1000) : 0; // Duration in seconds as integer

            // Validate track data before creating new track
            if (locationCount < 5 || totalDistance === 0 || avgSpeed === 0) {
                console.log(`[User: ${userId}] Track validation failed - Not creating new track. Metrics:`, {
                    locationCount,
                    totalDistance: totalDistance.toFixed(2),
                    avgSpeed: avgSpeed.toFixed(2),
                });
            } else {
                // Create new track document with auto-generated ID
                const newTrackRef = db.collection(`users/${userId}/tracks`).doc();

                // Create track document with summary data
                await newTrackRef.set({
                    id: newTrackRef.id,
                    startTime,
                    endTime,
                    avgSpeed: avgSpeed,
                    maxSpeed: maxSpeed,
                    distance: totalDistance,
                    duration: duration,
                    locationCount,
                    dateCreated: Timestamp.now(),
                    breadcrumbs,
                    name: deletedData?.name,
                    startAddress: deletedData?.startAddress,
                    endAddress: deletedData?.endAddress,
                    screenAccessCount: deletedData?.screenAccessCount,
                });

                // Log the calculated metrics
                console.log(`[User: ${userId}] Track Metrics for ${newTrackRef.id}:`, {
                    averageSpeed: avgSpeed.toFixed(2),
                    maxSpeed: maxSpeed.toFixed(2),
                    duration: duration.toFixed(2),
                    totalDistance: totalDistance.toFixed(2),
                    locationCount,
                });
            }
        }

        // Now delete the locations collection
        await deleteSubCollection(locationsRef);
        console.log(`[User: ${userId}] All documents in 'locations' sub-collection under LiveTrack ${trackId} deleted.`);
    } catch (error) {
        console.error(`[User: ${userId}] Error during LiveTrack deletion operation for trackId: ${trackId}`, error);
    }

    return Promise.resolve();
});

export const onLiveTrackCreated = onDocumentCreated('users/{userId}/liveTracks/{trackId}', async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const createdData = event.data?.data();

    console.log(`[User: ${userId}] LiveTrack document with ID ${trackId} was created`);
    console.log(`[User: ${userId}] Created data:`, createdData);

    try {
        // Delete all documents in the Locations subcollection
        const locationsRef = db.collection(`users/${userId}/liveTracks/${trackId}/locations`);
        await deleteSubCollection(locationsRef);
        // You can add any initialization logic here for new LiveTrack documents
        console.log(`[User: ${userId}] Successfully processed new LiveTrack creation for trackId: ${trackId}`);
    } catch (error) {
        console.error(`[User: ${userId}] Error during LiveTrack creation operation for trackId: ${trackId}`, error);
    }

    return Promise.resolve();
});

// export const onLiveTrackUpdated = onDocumentUpdated('users/{userId}/liveTracks/{trackId}', async (event) => {
//     const userId = event.params.userId;
//     const trackId = event.params.trackId;
//     const beforeData = event.data?.before.data();
//     const afterData = event.data?.after.data();

//     console.log(`[User: ${userId}] LiveTrack document with ID ${trackId} was updated`);
//     console.log(`[User: ${userId}] Before data:`, beforeData);
//     console.log(`[User: ${userId}] After data:`, afterData);

//     try {
//         // Delete all documents in the Locations subcollection
//         const locationsRef = db.collection(`users/${userId}/liveTracks/${trackId}/locations`);
//         await deleteSubCollection(locationsRef);
//         // You can add any initialization logic here for new LiveTrack documents
//         console.log(`[User: ${userId}] Successfully processed new LiveTrack creation for trackId: ${trackId}`);
//     } catch (error) {
//         console.error(`[User: ${userId}] Error during LiveTrack creation operation for trackId: ${trackId}`, error);
//     }

//     return Promise.resolve();
// });

// export const eventhandler = onCustomEventPublished("firebase.extensions.storage-resize-images.v1.onSuccess", async (event) => {
//     // Handle extension event here.

//     functions.logger.info("Resize Image is successful", event);

//     const fileBucket = event.data.input.bucket;
//     const name = event.data.input.name;
//     const compressName = event.data.outputs[0].outputFilePath;


//     console.log(`bucket: ${fileBucket} name: ${name}  compressed: ${compressName}`);
//     // const bucket = firebase.Storage().ref.bucket(fileBucket);
//     const bucket = admin.storage().bucket(fileBucket);
//     // rename the original file temporarily
//     await bucket.file(name).rename(name + '.tmp');
//     await bucket.file(compressName).rename(name);
//     await bucket.file(name + '.tmp').delete();

//     // var desertRef = storageRef.child('images/desert.jpg');

//     // Additional operations based on the event data can be performed here
//     return Promise.resolve();
// });

export const scheduledFunction = onSchedule({
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
}, async (event) => {
    console.log('Scheduled function triggered at:', new Date().toISOString());

    try {
        // Get all users from the users collection
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
            console.log('No users found in the database');
            return;
        }

        console.log(`Found ${usersSnapshot.size} users to process`);

        // Process each user and send a silent notification
        const notificationPromises = usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            const userId = userData.userId;

            if (!userId) {
                console.log(`User document ${userDoc.id} has no userId field, skipping`);
                return;
            }

            // Get the device token for this user
            const deviceToken = await getDeviceToken(userId);

            if (!deviceToken) {
                console.log(`No device token found for user ${userId}, skipping notification`);
                return;
            }

            // Create notification content
            const content = JSON.stringify({
                action: 'refresh',
                timestamp: new Date().toISOString(),
            });

            // Send the silent notification
            const result = await sendSilentPushNotification(deviceToken, content);

            if (result) {
                console.log(`Successfully sent silent notification to user ${userId}`);
            } else {
                console.log(`Failed to send silent notification to user ${userId}`);
            }
        });

        // Wait for all notifications to be processed
        await Promise.all(notificationPromises);

        console.log('Scheduled task completed successfully');
    } catch (error) {
        console.error('Error in scheduled function:', error);
    }
});
