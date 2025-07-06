/* eslint-disable max-len */
// import * as functions from 'firebase-functions';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {onDocumentCreated, onDocumentDeleted} from 'firebase-functions/v2/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {defineSecret} from 'firebase-functions/params';
// import {onCustomEventPublished} from "firebase-functions/v2/eventarc";
import * as admin from 'firebase-admin';
// import {getStorage} from 'firebase-admin/storage';
// import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {logger} from 'firebase-functions/v2';

initializeApp();
const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

// Define the Google API Key secret
const googleApiKeySecret = defineSecret('GOOGLE_API_KEY');
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
                    'apns-priority': '5',
                    // No apns-topic needed - Firebase auto-detects!
                },
                payload: {
                    aps: {
                        'content-available': 1,
                    },
                    shouldTrack: true,
                    timestamp: Date.now(),
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
 * @return {number} Distance between the points in meters (consistent with existing GPS data)
 */
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
}

/**
 * Calculates the course (bearing) between two points
 * @param {number} lat1 Latitude of the first point in degrees
 * @param {number} lon1 Longitude of the first point in degrees
 * @param {number} lat2 Latitude of the second point in degrees
 * @param {number} lon2 Longitude of the second point in degrees
 * @return {number} Course in degrees (0-360)
 */
function calculateCourse(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    bearing = (bearing + 360) % 360; // Normalize to 0-360 degrees

    return bearing;
}

/**
 * Finds the closest original breadcrumb to a snapped point
 * @param {number} snappedLat Latitude of the snapped point
 * @param {number} snappedLon Longitude of the snapped point
 * @param {any[]} originalBreadcrumbs Array of original breadcrumbs
 * @return {any|null} The closest original breadcrumb or null
 */
function findClosestOriginalBreadcrumb(snappedLat: number, snappedLon: number, originalBreadcrumbs: any[]): any | null {
    if (!originalBreadcrumbs || originalBreadcrumbs.length === 0) {
        return null;
    }

    let closestBreadcrumb = null;
    let minDistance = Infinity;

    for (const breadcrumb of originalBreadcrumbs) {
        if (breadcrumb.latitude && breadcrumb.longitude) {
            const distance = calculateDistanceMeters(snappedLat, snappedLon, breadcrumb.latitude, breadcrumb.longitude);
            if (distance < minDistance) {
                minDistance = distance;
                closestBreadcrumb = breadcrumb;
            }
        }
    }

    return closestBreadcrumb;
}

/**
 * Interpolates timestamp for a snapped point based on its position relative to original breadcrumbs
 * @param {number} snappedLat Latitude of the snapped point
 * @param {number} snappedLon Longitude of the snapped point
 * @param {any[]} originalBreadcrumbs Array of original breadcrumbs (sorted by timestamp)
 * @param {number} snappedIndex Index of the snapped point in the snapped array
 * @param {number} totalSnappedPoints Total number of snapped points
 * @return {any|null} Interpolated timestamp or null
 */
function interpolateTimestamp(snappedLat: number, snappedLon: number, originalBreadcrumbs: any[], snappedIndex: number, totalSnappedPoints: number): any | null {
    if (!originalBreadcrumbs || originalBreadcrumbs.length < 2) {
        return null;
    }

    // Find the two closest original breadcrumbs that surround this snapped point
    const firstBreadcrumb = originalBreadcrumbs[0];
    const lastBreadcrumb = originalBreadcrumbs[originalBreadcrumbs.length - 1];

    if (!firstBreadcrumb.timestamp || !lastBreadcrumb.timestamp) {
        return null;
    }

    // Simple linear interpolation based on the snapped point's position in the sequence
    const progress = snappedIndex / (totalSnappedPoints - 1);
    const startTime = firstBreadcrumb.timestamp.toMillis();
    const endTime = lastBreadcrumb.timestamp.toMillis();
    const interpolatedTime = startTime + (endTime - startTime) * progress;

    // Convert back to Firestore Timestamp
    return admin.firestore.Timestamp.fromMillis(interpolatedTime);
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

        // Get the user document where the userId matches (only if userId exists)
        if (userId) {
            const deviceToken = await getDeviceToken(userId);
            // Send a notification to the user
            if (deviceToken) {
                await sendPushNotification(deviceToken, 'Circle Deleted', `Circle ${circleName || 'Unknown'} has been deleted.`);
            }
        } else {
            console.log('No userId found in deleted circle data, skipping notification');
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

/**
 * Creates a track notification for the user
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 */
async function createTrackNotification(userId: string, trackId: string, trackData: any): Promise<void> {
    try {
        logger.info(`${userId}: Creating track notification for track ${trackId}`);

        // Create a new document reference to get the ID before writing
        const notificationRef = db.collection(`users/${userId}/notifications`).doc();

        // Create a track notification object with strong typing
        const trackNotification: TrackNotification = {
            startTime: trackData.startTime,
            endTime: trackData.endTime,
            avgSpeed: trackData.avgSpeed,
            maxSpeed: trackData.maxSpeed,
            distance: trackData.distance,
            duration: trackData.duration,
        };

        // Create the notification object with strong typing
        const notificationData: Notification = {
            id: notificationRef.id, // Store the generated ID
            userId: userId, // userId for the user that generated the event
            circleId: 'circleId', // The circleId
            userName: trackData.name || 'Unknown User', // userName for the user that generated the event
            trackNotification: trackNotification,
            locationNotification: undefined, // set undefined for track notifications
            dateCreated: Timestamp.now(), // Firestore timestamp
        };

        // Insert into user's 'notifications' subcollection
        await notificationRef.set(notificationData);
        logger.info(`${userId}: Successfully created track notification for track ${trackId}`);
    } catch (error) {
        logger.error(`${userId}: Error creating track notification for track ${trackId}: ${error}`);
        // Don't throw - notification creation failure shouldn't stop other processing
    }
}

/**
 * Processes a track through Google Roads API for road snapping
 * @param {string} userId The user ID
 * @param {string} trackId The track ID
 * @param {any} trackData The track data
 * @param {admin.firestore.DocumentReference} trackRef The track document reference
 */
async function processTrackWithGoogleRoads(userId: string, trackId: string, trackData: any, trackRef: admin.firestore.DocumentReference): Promise<void> {
    try {
        logger.info(`${userId}: Starting Google Roads API processing for track ${trackId}`);

        // Validate breadcrumbs exist and meet minimum requirements for Roads processing
        if (!trackData.breadcrumbs || !Array.isArray(trackData.breadcrumbs) || trackData.breadcrumbs.length < 2) {
            logger.info(`${userId}: Track ${trackId} has insufficient breadcrumbs (${trackData.breadcrumbs?.length || 0}), skipping Roads processing`);
            return;
        }

        // Check if already processed to avoid reprocessing
        if (trackData.snappedToRoads === true) {
            logger.info(`${userId}: Track ${trackId} already processed with Google Roads, skipping Roads processing`);
            return;
        }

        logger.info(`${userId}: Processing ${trackData.breadcrumbs.length} breadcrumbs for track ${trackId} with Google Roads API`);

        // Sort breadcrumbs by timestamp (Firestore Timestamp objects) to ensure chronological order
        const breadcrumbs = [...trackData.breadcrumbs].sort((a, b) => {
            // Handle missing timestamps
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;

            // For Firestore Timestamps, use toMillis() method
            const aTime = a.timestamp.toMillis();
            const bTime = b.timestamp.toMillis();

            return aTime - bTime;
        });

        logger.info(`${userId}: Sorted ${breadcrumbs.length} breadcrumbs chronologically for track ${trackId}`);

        // Get Google API key from Firebase secrets (Firebase v2)
        const googleApiKey = googleApiKeySecret.value();
        if (!googleApiKey) {
            logger.error(`${userId}: Google API key not configured in Firebase secrets, skipping Roads processing for track ${trackId}`);
            return;
        }

        // Google Roads API has a limit of 100 points per request, so we may need to batch
        const maxPointsPerRequest = 100;
        const batches = [];

        for (let i = 0; i < breadcrumbs.length; i += maxPointsPerRequest) {
            batches.push(breadcrumbs.slice(i, i + maxPointsPerRequest));
        }

        logger.info(`${userId}: Processing ${batches.length} batches for track ${trackId}`);

        let allSnappedPoints: any[] = [];

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            // Prepare path string for Google Roads API (lat,lng|lat,lng|...)
            const pathString = batch.map((breadcrumb: any) =>
                `${breadcrumb.latitude},${breadcrumb.longitude}`
            ).join('|');

            const url = `https://roads.googleapis.com/v1/snapToRoads?path=${encodeURIComponent(pathString)}&interpolate=true&key=${googleApiKey}`;

            logger.info(`${userId}: Calling Google Roads API for batch ${batchIndex + 1}/${batches.length} of track ${trackId}`);

            // Call Google Roads API
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`${userId}: Google Roads API error for track ${trackId}, batch ${batchIndex + 1}: ${response.status} - ${errorText}`);

                // Mark as failed but don't throw to avoid retries
                await trackRef.update({
                    roadsProcessingFailed: true,
                    roadsProcessingError: `API error batch ${batchIndex + 1}: ${response.status}`,
                    roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return;
            }

            const roadsResult = await response.json();

            // Validate response structure
            if (!roadsResult.snappedPoints || !Array.isArray(roadsResult.snappedPoints)) {
                logger.error(`${userId}: Invalid Google Roads API response for track ${trackId}, batch ${batchIndex + 1}`);

                await trackRef.update({
                    roadsProcessingFailed: true,
                    roadsProcessingError: `Invalid API response structure batch ${batchIndex + 1}`,
                    roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return;
            }

            logger.info(`${userId}: Successfully snapped ${roadsResult.snappedPoints.length} points for batch ${batchIndex + 1} of track ${trackId}`);
            allSnappedPoints = allSnappedPoints.concat(roadsResult.snappedPoints);
        }

        logger.info(`${userId}: Successfully processed all batches with ${allSnappedPoints.length} total snapped points for track ${trackId}`);

        // Convert snapped points back to breadcrumb format with inferred data from original breadcrumbs
        const snappedBreadcrumbs = allSnappedPoints.map((snappedPoint: any, index: number) => {
            // Find the closest original breadcrumb to infer missing data
            const originalBreadcrumb = findClosestOriginalBreadcrumb(
                snappedPoint.location.latitude,
                snappedPoint.location.longitude,
                breadcrumbs
            );

            // Calculate speed and course if we have enough context
            const inferredSpeed = originalBreadcrumb?.speed || null;
            let inferredCourse = originalBreadcrumb?.course || null;
            let inferredTimestamp = originalBreadcrumb?.timestamp || null;

            // If we have previous snapped point, calculate course between them
            if (index > 0) {
                const prevSnapped = allSnappedPoints[index - 1];
                inferredCourse = calculateCourse(
                    prevSnapped.location.latitude,
                    prevSnapped.location.longitude,
                    snappedPoint.location.latitude,
                    snappedPoint.location.longitude
                );
            }

            // Interpolate timestamp if we have surrounding original points
            if (index > 0 && index < allSnappedPoints.length - 1) {
                inferredTimestamp = interpolateTimestamp(
                    snappedPoint.location.latitude,
                    snappedPoint.location.longitude,
                    breadcrumbs,
                    index,
                    allSnappedPoints.length
                );
            }

            return {
                latitude: snappedPoint.location.latitude,
                longitude: snappedPoint.location.longitude,
                // Inferred data from original breadcrumbs
                timestamp: inferredTimestamp,
                accuracy: null, // Road snapping replaces GPS accuracy
                altitude: originalBreadcrumb?.altitude || null, // Keep original altitude if available
                speed: inferredSpeed,
                course: inferredCourse,
                // Add snapping metadata
                wasSnapped: true,
                snappedIndex: index, // Index in the snapped array
                placeId: snappedPoint.placeId || null, // Google's place ID for the road
                originalBreadcrumbIndex: originalBreadcrumb ? breadcrumbs.indexOf(originalBreadcrumb) : null,
            };
        });

        // Calculate distance using the snapped coordinates (in meters for consistency with GPS data)
        let totalDistanceMeters = 0;
        for (let i = 1; i < snappedBreadcrumbs.length; i++) {
            const prev = snappedBreadcrumbs[i - 1];
            const curr = snappedBreadcrumbs[i];
            totalDistanceMeters += calculateDistanceMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
        }

        // Update the track document with snapped data
        const updateData: any = {
            breadcrumbs: trackData.breadcrumbs, // Keep original for reference
            enhancedBreadcrumbs: snappedBreadcrumbs,
            snappedToRoads: true,
            distance: totalDistanceMeters, // Use calculated distance from snapped points (in meters)
            roadsProcessingFailed: false,
            roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await trackRef.update(updateData);

        logger.info(`${userId}: Successfully updated track ${trackId} with ${snappedBreadcrumbs.length} snapped breadcrumbs`);
        logger.info(`${userId}: Updated distance from ${trackData.distance.toFixed(2)} meters to ${totalDistanceMeters.toFixed(2)} meters for track ${trackId}`);
    } catch (error) {
        logger.error(`${userId}: Error processing track ${trackId} with Google Roads API: ${error}`);

        // Mark as failed but don't throw to avoid infinite retries
        try {
            await trackRef.update({
                roadsProcessingFailed: true,
                roadsProcessingError: error instanceof Error ? error.message : 'Unknown error',
                roadsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (updateError) {
            logger.error(`${userId}: Failed to update error status for track ${trackId}: ${updateError}`);
        }
    }
}

/**
 * Cloud Function triggered when a track is created
 * Creates a track notification AND automatically processes the track through Google Roads API
 */
export const onTrackCreated = onDocumentCreated({
    document: 'users/{userId}/tracks/{trackId}',
    secrets: [googleApiKeySecret],
}, async (event) => {
    const userId = event.params.userId;
    const trackId = event.params.trackId;
    const trackData = event.data?.data();

    if (!trackData) {
        logger.error(`${userId}: No track data found for track ${trackId}`);
        return;
    }

    logger.info(`${userId}: Processing new track ${trackId} - creating notification and processing with Google Roads API`);

    // Execute both operations in parallel for better performance
    await Promise.allSettled([
        createTrackNotification(userId, trackId, trackData),
        processTrackWithGoogleRoads(userId, trackId, trackData, event.data!.ref),
    ]);

    logger.info(`${userId}: Completed processing for track ${trackId}`);
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
            // let totalDistance = 0;
            // let prevLat: number | null = null;
            // let prevLon: number | null = null;
            const breadcrumbs: any[] = [];

            // Process all locations in order
            await Promise.all(locationsSnapshot.docs.map(async (doc) => {
                const locationData = doc.data();
                const speed = locationData.speed || 0;
                const timestamp = locationData.timestamp as Timestamp;
                // const latitude = locationData.latitude;
                // const longitude = locationData.longitude;

                if (!(timestamp instanceof Timestamp)) {
                    console.error(`[User: ${userId}] Invalid timestamp format in location document`);
                    return;
                }

                // Calculate distance if we have previous coordinates
                // if (prevLat !== null && prevLon !== null && latitude && longitude) {
                //     const segmentDistance = calculateDistance(prevLat, prevLon, latitude, longitude);
                //     // Only add distance if it's above a minimum threshold (10 meters) to filter GPS noise
                //     if (segmentDistance >= 0.01) { // 0.01 km = 10 meters
                //         totalDistance += segmentDistance;
                //     }
                // }
                // prevLat = latitude;
                // prevLon = longitude;

                // Update metrics - ensure speed is a valid number
                const validSpeed = (typeof speed === 'number' && !isNaN(speed)) ? speed : 0;
                totalSpeed += validSpeed;
                maxSpeed = Math.max(maxSpeed, validSpeed);
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

            // Calculate final metrics - ensure avgSpeed is always a valid number
            let avgSpeed = locationCount > 0 ? totalSpeed / locationCount : 0;
            avgSpeed = (typeof avgSpeed === 'number' && !isNaN(avgSpeed)) ? avgSpeed : 0;
            const duration = startTime && endTime ?
                Math.floor(((endTime as Timestamp).toMillis() - (startTime as Timestamp).toMillis()) / 1000) : 0; // Duration in seconds as integer

            // Validate track data before creating new track
            if (locationCount < 5 || deletedData?.distance === 0 || avgSpeed === 0) {
                console.log(`[User: ${userId}] Track validation failed - Not creating new track. Metrics:`, {
                    locationCount,
                    totalDistance: deletedData?.distance,
                    avgSpeed: avgSpeed,
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
                    distance: deletedData?.distance,
                    duration: duration,
                    locationCount,
                    dateCreated: Timestamp.now(),
                    breadcrumbs,
                    name: deletedData?.name,
                    startAddress: deletedData?.startAddress,
                    endAddress: deletedData?.endAddress,
                    screenAccessCount: deletedData?.screenAccessCount,
                });

                // Get user's circles and notify circle members
                const userDoc = await db.collection('users').where('userId', '==', userId).get();
                if (!userDoc.empty) {
                    const userData = userDoc.docs[0].data();
                    const circleIds = userData.circleIds || [];
                    const userName = userData.name || 'Someone';

                    // Process each circle the user is a member of
                    const circlePromises = circleIds.map(async (circleId: string) => {
                        try {
                            const circleDoc = await db.collection('circles').doc(circleId).get();
                            if (circleDoc.exists) {
                                const circleData = circleDoc.data();
                                const circleUsers = circleData?.users || [];

                                // Notify each user in the circle (except the track creator)
                                const notificationPromises = circleUsers
                                    // .filter((user: any) => user.id !== userId) // Don't notify the track creator
                                    .map(async (user: any) => {
                                        try {
                                            // Get device token for circle member
                                            const deviceToken = await getDeviceToken(user.id);

                                            if (deviceToken) {
                                                const title = 'New Track';
                                                const body = `${userName} completed a track: ${deletedData?.name || 'Untitled Track'}`;

                                                // Send push notification
                                                await sendPushNotification(deviceToken, title, body);
                                                console.log(`[User: ${userId}] Sent track notification to circle member ${user.id}`);
                                            }
                                        } catch (error) {
                                            console.error(`[User: ${userId}] Error sending notification to circle member ${user.id}:`, error);
                                        }
                                    });

                                await Promise.all(notificationPromises);
                            }
                        } catch (error) {
                            console.error(`[User: ${userId}] Error processing circle ${circleId}:`, error);
                        }
                    });

                    await Promise.all(circlePromises);
                }

                // Log the calculated metrics
                console.log(`[User: ${userId}] Track Metrics for ${newTrackRef.id}:`, {
                    averageSpeed: avgSpeed.toFixed(2),
                    maxSpeed: maxSpeed.toFixed(2),
                    duration: duration.toFixed(2),
                    totalDistance: deletedData?.distance.toFixed(2),
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
//         console.error(`

export const scheduledFunction = onSchedule({
    schedule: 'every 15 minutes',
    timeZone: 'UTC',
}, async () => {
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

        // Wait for all notifications to be sent
        await Promise.all(notificationPromises);

        console.log('Scheduled function completed successfully');
    } catch (error) {
        console.error('Error in scheduled function:', error);
        throw error;
    }
});

/**
 * Scheduled function that runs every 20 minutes to check user activity
 * Updates users to "stationary" status if they haven't been active for more than 20 minutes
 */
export const checkUserActivity = onSchedule({
    schedule: 'every 20 minutes',
    timeZone: 'UTC',
}, async () => {
    console.log('User activity check function triggered at:', new Date().toISOString());

    try {
        // Get all users from the users collection
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
            console.log('No users found in the database');
            return;
        }

        console.log(`Found ${usersSnapshot.size} users to check for activity`);

        // Calculate the threshold time (20 minutes ago)
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        const twentyMinutesAgoTimestamp = Timestamp.fromDate(twentyMinutesAgo);

        let updatedCount = 0;
        let skippedCount = 0;

        // Process each user to check their activity
        const updatePromises = usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            const userId = userData.userId;
            const lastActivity = userData.lastActivity;
            const currentActivity = userData.activity;

            if (!userId) {
                console.log(`User document ${userDoc.id} has no userId field, skipping`);
                skippedCount++;
                return;
            }

            // Check if lastActivity field exists and is a valid Timestamp
            if (!lastActivity || !(lastActivity instanceof Timestamp)) {
                console.log(`User ${userId} has no valid lastActivity timestamp, skipping`);
                skippedCount++;
                return;
            }

            // Check if user has been inactive for more than 20 minutes
            if (lastActivity.toMillis() < twentyMinutesAgoTimestamp.toMillis()) {
                // Only update if the current activity is not already "stationary"
                if (currentActivity !== 'stationary') {
                    try {
                        await userDoc.ref.update({
                            activity: 'stationary',
                            lastActivity: Timestamp.now(),
                        });

                        console.log(`Updated user ${userId} to stationary status (last activity: ${lastActivity.toDate().toISOString()})`);
                        updatedCount++;
                    } catch (error) {
                        console.error(`Error updating user ${userId} activity status:`, error);
                    }
                } else {
                    console.log(`User ${userId} is already stationary, skipping update`);
                    skippedCount++;
                }
            } else {
                console.log(`User ${userId} is still active (last activity: ${lastActivity.toDate().toISOString()})`);
                skippedCount++;
            }
        });

        // Wait for all updates to complete
        await Promise.all(updatePromises);

        console.log(`User activity check completed: ${updatedCount} users updated to stationary, ${skippedCount} users skipped`);
    } catch (error) {
        console.error('Error in user activity check function:', error);
        throw error;
    }
});
